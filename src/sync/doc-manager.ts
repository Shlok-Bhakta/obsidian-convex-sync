import type { Extension } from "@codemirror/state";
import type { App } from "obsidian";
import { normalizePath, TFile } from "obsidian";
import type { ConvexClient } from "convex/browser";
import { Awareness } from "y-protocols/awareness.js";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import type { api } from "../../convex/_generated/api";
import { ConvexAwarenessSync } from "./convex-awareness-sync";
import { ConvexYjsProvider } from "./ConvexYjsProvider";
import { flushYjsTextToActiveMarkdownEditor } from "./flush-ytext-to-cm";
import { isLocalChangeSuppressed, withSuppressedLocalChange } from "./local-change-suppressor";
import {
	pushTextContentSnapshot,
	readRemoteTextContent,
} from "./text-sync-transport";
import { createTextYDoc, textDocIdForPath } from "./text-sync-shared";
import { YjsLocalCache } from "./yjs-local-cache";

type DocEntry = {
	doc: Y.Doc;
	awareness: Awareness;
	provider: ConvexYjsProvider;
	/** Attached after yCollab + updateOptions so remote cursors never target an empty CM doc. */
	awarenessSync: ConvexAwarenessSync | null;
	/** Guards against stale remote awareness cursor offsets crashing CodeMirror. */
	awarenessSanitizer: ((event: { added: number[]; updated: number[]; removed: number[] }) => void) | null;
	/** Clears the debounced persist timer so a late fire cannot resurrect a deleted/renamed path on Convex. */
	cancelPersistDebounced: () => void;
};

export class DocManager {
	// Mutable array - Obsidian watches this reference.
	readonly extensions: Extension[] = [];
	private current: DocEntry | null = null;
	private currentPath: string | null = null;
	private destroyed = false;
	private recoveringFromDivergence = false;
	/** Paths currently being pulled from remote; prevents overlapping remote fetches for the same path. */
	readonly pullingRemotePaths = new Set<string>();
	/** Prevents overlapping `pullRemoteTextFile` runs for the same path (subscription bursts / catch-up races). */
	private readonly activeRemoteTextPulls = new Set<string>();

	/** Current Yjs awareness for the open collaborative doc (sidebar presence merge). */
	getCurrentAwareness(): Awareness | null {
		return this.current?.awareness ?? null;
	}

	constructor(
		private readonly app: App,
		private readonly client: ConvexClient,
		private readonly convexApi: typeof api,
		private readonly clientId: string,
		private readonly convexSecret: string,
	) {}

	async onFileOpen(path: string): Promise<void> {
		const normPath = normalizePath(path);
		if (this.currentPath != null && normalizePath(this.currentPath) === normPath) {
			return;
		}
		await this.closeCurrentDoc();

		// Reserve immediately after close so background text pulls skip `vault.modify` for this
		// path during cache load + Convex init (avoids CM/Yjs seeing repeated disk writes).
		this.currentPath = normPath;

		const docId = this.pathToDocId(normPath);
		const doc = new Y.Doc();
		const cachedDoc = new Y.Doc();
		const awareness = new Awareness(doc);

		// Hydrate cache into a temp doc first. The live doc is hydrated from Convex
		// first so stale cache never masks fresher remote/mobile edits on file-open.
		await YjsLocalCache.load(docId, cachedDoc);

		const provider = new ConvexYjsProvider(
			this.client,
			docId,
			normPath,
			doc,
			this.convexApi,
			this.convexSecret,
			this.clientId,
		);
		provider.onDivergence = () => {
			void this.recoverFromEditorSyncDivergence();
		};
		try {
			await provider.init();
			const cacheDelta = Y.encodeStateAsUpdate(cachedDoc, Y.encodeStateVector(doc));
			if (cacheDelta.byteLength > 0) {
				Y.applyUpdate(doc, cacheDelta);
			}
		} catch (e: unknown) {
			console.warn(
				"[DocManager] Convex Yjs init failed after retries; opening from local cache until the connection recovers",
				e,
			);
			const fromCache = Y.encodeStateAsUpdate(cachedDoc);
			if (fromCache.byteLength > 0) {
				Y.applyUpdate(doc, fromCache);
			}
		} finally {
			cachedDoc.destroy();
		}

		awareness.setLocalStateField("user", {
			name: this.clientId.slice(0, 8),
			color: hashColor(this.clientId),
		});
		awareness.setLocalStateField("openFilePath", normPath);

		const { schedule: schedulePersist, cancel: cancelPersistDebounced } =
			debounceWithCancel(async () => {
				if (this.destroyed || this.currentPath !== normPath) return;
				await YjsLocalCache.save(docId, doc);
			}, 500);

		doc.on("update", () => {
			schedulePersist();
		});

		const ytext = doc.getText("content");
		const awarenessSanitizer = (event: {
			added: number[];
			updated: number[];
			removed: number[];
		}): void => {
			const currentDocLen = ytext.length;
			const sanitizedClients: number[] = [];
			for (const clientId of [...event.added, ...event.updated]) {
				const state = awareness.getStates().get(clientId);
				if (!state || typeof state !== "object") continue;
				const stateObj = state as Record<string, unknown>;
				const cursor = stateObj.cursor;
				if (!cursor || typeof cursor !== "object") continue;
				const cursorObj = cursor as Record<string, unknown>;
				let changed = false;
				for (const key of ["anchor", "head", "from", "to"] as const) {
					const raw = cursorObj[key];
					if (typeof raw !== "number" || !Number.isFinite(raw)) {
						continue;
					}
					const clamped = clamp(raw, 0, currentDocLen);
					if (clamped !== raw) {
						cursorObj[key] = clamped;
						changed = true;
					}
				}
				// If cursor is malformed, clear it to prevent downstream range errors.
				if (!isValidCursorShape(cursorObj)) {
					delete stateObj.cursor;
					changed = true;
				}
				if (changed) {
					awareness.getStates().set(clientId, stateObj);
					sanitizedClients.push(clientId);
				}
			}
			if (sanitizedClients.length > 0) {
				const payload = {
					added: [] as number[],
					updated: sanitizedClients,
					removed: [] as number[],
				};
				awareness.emit("change", [payload, "sanitizer"]);
				awareness.emit("update", [payload, "sanitizer"]);
			}
		};
		awareness.on("update", awarenessSanitizer);
		const entry: DocEntry = {
			doc,
			awareness,
			provider,
			awarenessSync: null,
			awarenessSanitizer,
			cancelPersistDebounced,
		};
		this.current = entry;

		this.extensions.length = 0;
		this.extensions.push(yCollab(ytext, awareness));
		this.app.workspace.updateOptions();
		// Convex init ran before yCollab existed, so CM never received a Y→CM observe callback.
		// Flush once now (and again after startSync) so disk cannot sit stale vs Y or poison Y via CM→Y.
		flushYjsTextToActiveMarkdownEditor(this.app, normPath, ytext);

		// Remote Yjs and awareness rows may arrive in the same turn as setup.
		// Defer until after CM has applied yCollab so editor length matches Y.Text.
		let awarenessAttached = false;
		const attachAwareness = (): void => {
			if (this.destroyed || this.current !== entry || awarenessAttached) return;
			awarenessAttached = true;
			provider.startSync();
			flushYjsTextToActiveMarkdownEditor(this.app, normPath, ytext);
			entry.awarenessSync =
				this.convexSecret.trim() !== ""
					? new ConvexAwarenessSync(
							this.client,
							docId,
							awareness,
							this.convexApi.yjsAwareness,
							this.convexSecret,
						)
					: null;
		};
		requestAnimationFrame(attachAwareness);
	}

	/**
	 * Close and re-open the active note so Convex `init` + Yjs wiring runs again.
	 * Used when CodeMirror throws after Yjs/remote divergence (e.g. invalid change range).
	 */
	async recoverFromEditorSyncDivergence(): Promise<void> {
		if (this.recoveringFromDivergence) return;
		const path = this.currentPath;
		if (!path) return;
		this.recoveringFromDivergence = true;
		try {
			console.warn("[DocManager] Yjs/CodeMirror divergence — re-syncing from server");
			await this.closeCurrentDoc();
			await this.onFileOpen(path);
		} catch (e: unknown) {
			console.warn("[DocManager] recoverFromEditorSyncDivergence failed", e);
		} finally {
			this.recoveringFromDivergence = false;
		}
	}

	async closeCurrentDoc(): Promise<void> {
		if (!this.current) return;
		const { doc, awareness, provider, awarenessSync, awarenessSanitizer, cancelPersistDebounced } =
			this.current;
		cancelPersistDebounced();
		if (this.currentPath) {
			await provider.flush();
			await YjsLocalCache.save(this.pathToDocId(this.currentPath), doc);
		}
		if (awarenessSync) {
			awarenessSync.flush();
			awareness.setLocalState(null);
			awarenessSync.flush();
			awarenessSync.destroy();
		}
		if (awarenessSanitizer) {
			awareness.off("update", awarenessSanitizer);
		}
		provider.destroy();
		awareness.destroy();
		doc.destroy();
		this.extensions.length = 0;
		this.app.workspace.updateOptions();
		this.current = null;
		this.currentPath = null;
	}

	async dispose(): Promise<void> {
		this.destroyed = true;
		await this.closeCurrentDoc();
	}

	/** Register a new Markdown file on the server using current disk content before first open. */
	async onFileCreated(path: string): Promise<void> {
		const norm = normalizePath(path);
		if (this.pullingRemotePaths.has(norm) || isLocalChangeSuppressed(norm)) return;
		const abstract = this.app.vault.getAbstractFileByPath(norm);
		const content =
			abstract instanceof TFile && abstract.extension === "md"
				? await this.app.vault.cachedRead(abstract)
				: "";
		await this.pushDiskSnapshot(norm, content);
	}

	/**
	 * Fallback path for vault modify events when a Markdown file changes outside active
	 * Yjs doc wiring (for example during startup races on newly created notes).
	 */
	async onFileModified(path: string): Promise<void> {
		if (
			this.current != null &&
			this.currentPath != null &&
			normalizePath(this.currentPath) === normalizePath(path)
		) {
			return;
		}
		if (isLocalChangeSuppressed(path)) {
			return;
		}
		const abstract = this.app.vault.getAbstractFileByPath(path);
		if (!(abstract instanceof TFile) || abstract.extension !== "md") {
			return;
		}
		const content = await this.app.vault.cachedRead(abstract);
		await this.pushDiskSnapshot(path, content, abstract.stat.mtime);
	}

	async onFileRenamed(oldPath: string, newPath: string): Promise<void> {
		const oldDocId = this.pathToDocId(oldPath);
		const wasCurrentDoc =
			this.currentPath != null && normalizePath(this.currentPath) === normalizePath(oldPath);

		if (wasCurrentDoc) {
			await this.closeCurrentDoc();
		}

		await YjsLocalCache.remove(oldDocId);

		await this.client.mutation(this.convexApi.fileSync.removeFilesByPath, {
			convexSecret: this.convexSecret,
			removedPaths: [normalizePath(oldPath)],
		});
		const renamed = this.app.vault.getAbstractFileByPath(normalizePath(newPath));
		const content =
			renamed instanceof TFile && renamed.extension === "md"
				? await this.app.vault.cachedRead(renamed)
				: "";
		await this.pushDiskSnapshot(newPath, content);

		// Obsidian may keep the renamed note open without emitting a new file-open event.
		// Rebind immediately so edits after rename keep syncing to Convex in real time.
		if (wasCurrentDoc) {
			await this.onFileOpen(newPath);
		}
	}

	async onFileDeleted(path: string): Promise<void> {
		if (isLocalChangeSuppressed(path)) {
			return;
		}
		const docId = this.pathToDocId(path);
		if (this.currentPath != null && normalizePath(this.currentPath) === normalizePath(path)) {
			await this.closeCurrentDoc();
		}
		await YjsLocalCache.remove(docId);
		await this.client.mutation(this.convexApi.fileSync.removeFilesByPath, {
			convexSecret: this.convexSecret,
			removedPaths: [normalizePath(path)],
		});
	}

	/**
	 * For each remote Markdown path without local idb cache, pull full Yjs state once and persist.
	 * Ensures Convex has been exercised for known files and improves cold-start cache coverage.
	 */
	async warmUpAllDocs(remotePaths: string[]): Promise<void> {
		for (const path of remotePaths) {
			if (this.destroyed) return;
			const docId = this.pathToDocId(path);
			if (await YjsLocalCache.hasCachedState(docId)) continue;
			const doc = new Y.Doc();
			try {
				const remoteContent = await readRemoteTextContent({
					client: this.client,
					convexApi: this.convexApi,
					convexSecret: this.convexSecret,
					vaultName: this.app.vault.getName(),
					path,
				});
				doc.getText("content").insert(0, remoteContent);
				if (remoteContent.length > 0) {
					await YjsLocalCache.save(docId, doc);
				}
			} catch (e) {
				console.warn(`[DocManager] warmUp failed for ${path}`, e);
			} finally {
				doc.destroy();
			}
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	/**
	 * Pull Yjs state for a text file discovered from the remote metadata subscription,
	 * create or update the local file on disk, and persist the local cache + manifest.
	 */
	async pullRemoteTextFile(path: string): Promise<void> {
		const norm = normalizePath(path);
		if (this.activeRemoteTextPulls.has(norm)) return;
		this.activeRemoteTextPulls.add(norm);
		const docId = this.pathToDocId(norm);
		this.pullingRemotePaths.add(norm);
		try {
			const content = await readRemoteTextContent({
				client: this.client,
				convexApi: this.convexApi,
				convexSecret: this.convexSecret,
				vaultName: this.app.vault.getName(),
				path: norm,
			});
			const doc = createTextYDoc(content);

			const parent = folderPathForFile(norm);
			if (parent) {
				const parentNorm = normalizePath(parent);
				if (!(await this.app.vault.adapter.exists(parentNorm))) {
					await withSuppressedLocalChange(parentNorm, async () => {
						await this.app.vault.createFolder(parentNorm).catch(() => {});
					});
				}
			}

			const existing = this.app.vault.getAbstractFileByPath(norm);
			await withSuppressedLocalChange(norm, async () => {
				if (existing instanceof TFile) {
					await this.app.vault.modify(existing, content);
				} else if (await this.app.vault.adapter.exists(norm)) {
					await this.app.vault.adapter.write(norm, content);
				} else {
					await this.app.vault.create(norm, content);
				}
			});

			await YjsLocalCache.save(docId, doc);
			doc.destroy();
		} catch (e) {
			console.warn(`[DocManager] pullRemoteTextFile failed for ${path}`, e);
		} finally {
			this.pullingRemotePaths.delete(norm);
			this.activeRemoteTextPulls.delete(norm);
		}
	}

	/**
	 * Batch-pull remote text files. Skips paths that are already cached or currently open.
	 * Called by BinarySyncManager when it discovers remote text files from subscription/catch-up.
	 */
	async pullRemoteTextFiles(paths: string[]): Promise<void> {
		for (const path of new Set(paths)) {
			if (this.destroyed) return;
			if (
				this.currentPath != null &&
				normalizePath(this.currentPath) === normalizePath(path)
			) {
				continue;
			}
			await this.pullRemoteTextFile(path);
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	private pathToDocId(path: string): string {
		return textDocIdForPath(this.app.vault.getName(), path);
	}

	private async pushDiskSnapshot(
		path: string,
		content: string,
		updatedAtMs = Date.now(),
	): Promise<void> {
		const norm = normalizePath(path);
		const doc = await pushTextContentSnapshot({
			client: this.client,
			convexApi: this.convexApi,
			convexSecret: this.convexSecret,
			clientId: this.clientId,
			vaultName: this.app.vault.getName(),
			path: norm,
			content,
			updatedAtMs,
		});
		try {
			await YjsLocalCache.save(this.pathToDocId(norm), doc);
		} finally {
			doc.destroy();
		}
	}
}

function hashColor(id: string): string {
	let hash = 0;
	for (const c of id) hash = (Math.imul(31, hash) + c.charCodeAt(0)) | 0;
	return `hsl(${Math.abs(hash) % 360}, 70%, 45%)`;
}

function debounceWithCancel(
	fn: () => Promise<void>,
	ms: number,
): { schedule: () => void; cancel: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		schedule: () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				void fn();
			}, ms);
		},
		cancel: () => {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function isValidCursorShape(cursor: Record<string, unknown>): boolean {
	const expected = ["anchor", "head"];
	for (const key of expected) {
		const value = cursor[key];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			return false;
		}
	}
	return true;
}

function folderPathForFile(filePath: string): string | null {
	const slash = filePath.lastIndexOf("/");
	if (slash < 0) return null;
	return filePath.slice(0, slash);
}
