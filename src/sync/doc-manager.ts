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
import { YjsLocalCache } from "./yjs-local-cache";

type DocEntry = {
	doc: Y.Doc;
	awareness: Awareness;
	provider: ConvexYjsProvider;
	/** Attached after yCollab + updateOptions so remote cursors never target an empty CM doc. */
	awarenessSync: ConvexAwarenessSync | null;
	/** Guards against stale remote awareness cursor offsets crashing CodeMirror. */
	awarenessSanitizer: ((event: { added: number[]; updated: number[]; removed: number[] }) => void) | null;
};

export class DocManager {
	// Mutable array - Obsidian watches this reference.
	readonly extensions: Extension[] = [];
	private current: DocEntry | null = null;
	private currentPath: string | null = null;
	private destroyed = false;

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
		if (path === this.currentPath) return;
		await this.closeCurrentDoc();

		const docId = this.pathToDocId(path);
		const doc = new Y.Doc();
		const cachedDoc = new Y.Doc();
		const awareness = new Awareness(doc);

		// Hydrate cache into a temp doc first. The live doc is hydrated from Convex
		// first so stale cache never masks fresher remote/mobile edits on file-open.
		await YjsLocalCache.load(docId, cachedDoc);

		const provider = new ConvexYjsProvider(
			this.client,
			docId,
			doc,
			this.convexApi.yjs,
		);
		try {
			await provider.init();
			const cacheDelta = Y.encodeStateAsUpdate(cachedDoc, Y.encodeStateVector(doc));
			if (cacheDelta.byteLength > 0) {
				Y.applyUpdate(doc, cacheDelta);
			}
		} finally {
			cachedDoc.destroy();
		}

		awareness.setLocalStateField("user", {
			name: this.clientId.slice(0, 8),
			color: hashColor(this.clientId),
		});
		awareness.setLocalStateField("openFilePath", path);

		const persistDocAndManifest = debounce(async () => {
			await YjsLocalCache.save(docId, doc);
			const content = doc.getText("content").toString();
			const hash = await sha256Utf8(content);
			await this.client.mutation(this.convexApi.fileSync.registerTextFile, {
				convexSecret: this.convexSecret,
				path: normalizePath(path),
				contentHash: hash,
				sizeBytes: new TextEncoder().encode(content).length,
				updatedAtMs: Date.now(),
				clientId: this.clientId,
			});
		}, 500);

		doc.on("update", () => {
			persistDocAndManifest();
		});

		const ytext = doc.getText("content");
		const awarenessSanitizer = (event: {
			added: number[];
			updated: number[];
			removed: number[];
		}): void => {
			const currentDocLen = ytext.length;
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
				}
			}
		};
		awareness.on("update", awarenessSanitizer);
		const entry: DocEntry = {
			doc,
			awareness,
			provider,
			awarenessSync: null,
			awarenessSanitizer,
		};
		this.current = entry;
		this.currentPath = path;

		this.extensions.length = 0;
		this.extensions.push(yCollab(ytext, awareness));
		this.app.workspace.updateOptions();

		// Remote Yjs and awareness rows may arrive in the same turn as setup.
		// Defer until after CM has applied yCollab so editor length matches Y.Text.
		let awarenessAttached = false;
		const attachAwareness = (): void => {
			if (this.destroyed || this.current !== entry || awarenessAttached) return;
			awarenessAttached = true;
			provider.startSync();
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

	async closeCurrentDoc(): Promise<void> {
		if (!this.current) return;
		const { doc, awareness, provider, awarenessSync, awarenessSanitizer } = this.current;
		if (this.currentPath) {
			await this.registerTextManifest(this.currentPath, doc);
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

	/** Register a new Markdown file on the server manifest (empty content) before first open. */
	async onFileCreated(path: string): Promise<void> {
		const emptyHash = await sha256Utf8("");
		await this.registerTextManifestContent(path, emptyHash, 0);
	}

	/**
	 * Fallback path for vault modify events when a Markdown file changes outside active
	 * Yjs doc wiring (for example during startup races on newly created notes).
	 */
	async onFileModified(path: string): Promise<void> {
		if (this.currentPath === path && this.current) {
			return;
		}
		const abstract = this.app.vault.getAbstractFileByPath(path);
		if (!(abstract instanceof TFile) || abstract.extension !== "md") {
			return;
		}
		const content = await this.app.vault.cachedRead(abstract);
		const hash = await sha256Utf8(content);
		await this.registerTextManifestContent(
			path,
			hash,
			new TextEncoder().encode(content).length,
		);
	}

	async onFileRenamed(oldPath: string, newPath: string): Promise<void> {
		const oldDocId = this.pathToDocId(oldPath);
		const newDocId = this.pathToDocId(newPath);
		const wasCurrentDoc = this.currentPath === oldPath;

		if (wasCurrentDoc) {
			await this.closeCurrentDoc();
		}

		const hadCached = await YjsLocalCache.hasCachedState(oldDocId);
		if (hadCached) {
			const tempDoc = new Y.Doc();
			await YjsLocalCache.load(oldDocId, tempDoc);
			await YjsLocalCache.save(newDocId, tempDoc);
			tempDoc.destroy();
		}
		await YjsLocalCache.remove(oldDocId);

		await this.client.mutation(this.convexApi.fileSync.removeFilesByPath, {
			convexSecret: this.convexSecret,
			removedPaths: [normalizePath(oldPath)],
		});
		await this.onFileCreated(newPath);

		if (hadCached) {
			const doc = new Y.Doc();
			await YjsLocalCache.load(newDocId, doc);
			const provider = new ConvexYjsProvider(
				this.client,
				newDocId,
				doc,
				this.convexApi.yjs,
			);
			try {
				await provider.init();
				await provider.pushFullState();
				const content = doc.getText("content").toString();
				const hash = await sha256Utf8(content);
				await this.client.mutation(this.convexApi.fileSync.registerTextFile, {
					convexSecret: this.convexSecret,
					path: normalizePath(newPath),
					contentHash: hash,
					sizeBytes: new TextEncoder().encode(content).length,
					updatedAtMs: Date.now(),
					clientId: this.clientId,
				});
				await YjsLocalCache.save(newDocId, doc);
			} finally {
				provider.destroy();
				doc.destroy();
			}
		}

		// Obsidian may keep the renamed note open without emitting a new file-open event.
		// Rebind immediately so edits after rename keep syncing to Convex in real time.
		if (wasCurrentDoc) {
			await this.onFileOpen(newPath);
		}
	}

	async onFileDeleted(path: string): Promise<void> {
		const docId = this.pathToDocId(path);
		if (this.currentPath === path) {
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
			const provider = new ConvexYjsProvider(
				this.client,
				docId,
				doc,
				this.convexApi.yjs,
			);
			try {
				await provider.init();
				const content = doc.getText("content").toString();
				if (content.length > 0) {
					await YjsLocalCache.save(docId, doc);
				}
				await this.registerTextManifest(path, doc);
			} catch (e) {
				console.warn(`[DocManager] warmUp failed for ${path}`, e);
			} finally {
				provider.destroy();
				doc.destroy();
			}
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	private pathToDocId(path: string): string {
		return `${this.app.vault.getName()}::${path}`;
	}

	private async registerTextManifest(path: string, doc: Y.Doc): Promise<void> {
		const content = doc.getText("content").toString();
		const hash = await sha256Utf8(content);
		await this.registerTextManifestContent(
			path,
			hash,
			new TextEncoder().encode(content).length,
		);
	}

	private async registerTextManifestContent(
		path: string,
		contentHash: string,
		sizeBytes: number,
	): Promise<void> {
		await this.client.mutation(this.convexApi.fileSync.registerTextFile, {
			convexSecret: this.convexSecret,
			path: normalizePath(path),
			contentHash,
			sizeBytes,
			updatedAtMs: Date.now(),
			clientId: this.clientId,
		});
	}
}

function hashColor(id: string): string {
	let hash = 0;
	for (const c of id) hash = (Math.imul(31, hash) + c.charCodeAt(0)) | 0;
	return `hsl(${Math.abs(hash) % 360}, 70%, 45%)`;
}

function debounce(fn: () => Promise<void>, ms: number): () => void {
	let timer: ReturnType<typeof setTimeout>;
	return () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			void fn();
		}, ms);
	};
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function sha256Utf8(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return toHex(digest);
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
