import type { FunctionReference } from "convex/server";
import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import { del, get, keys, set } from "idb-keyval";
import { normalizePath, Notice, TFile, TFolder, type App } from "obsidian";
import { api } from "../../convex/_generated/api";
import {
	binaryTransferOpts,
	isTextSyncFile,
	readRemoteFileBytes,
	uploadLocalFile,
} from "../file-sync";
import type { MyPluginSettings } from "../settings";
import { obsidianConvexIdbStore } from "./yjs-local-cache";

const VAULT_SYNC_TIMESTAMP_KEY = "vaultSync:lastServerTimestamp";
const BINARY_HASH_KEY_PREFIX = "binarySync:hash:";

type RemoteFileMeta = {
	path: string;
	contentHash: string;
	updatedAtMs: number;
	isText: boolean;
};

type RemoteFolderMeta = {
	path: string;
	updatedAtMs: number;
	isExplicitlyEmpty: boolean;
};

type RemoteMetadata = {
	files: RemoteFileMeta[];
	folders: RemoteFolderMeta[];
};

function hashKeyForPath(path: string): string {
	return `${BINARY_HASH_KEY_PREFIX}${path}`;
}

function folderPathForFile(filePath: string): string | null {
	const slash = filePath.lastIndexOf("/");
	if (slash < 0) return null;
	return filePath.slice(0, slash);
}

/** Uses the vault adapter so we match on-disk state; avoids createFolder() throwing when the tree is not fully in the metadata cache yet. */
async function ensureFolderExistsOnAdapter(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (!normalized) return;
	if (await app.vault.adapter.exists(normalized)) return;
	const parent = folderPathForFile(normalized);
	if (parent) {
		await ensureFolderExistsOnAdapter(app, parent);
	}
	try {
		await app.vault.adapter.mkdir(normalized);
	} catch {
		if (await app.vault.adapter.exists(normalized)) return;
		throw new Error(`Failed to create folder: ${normalized}`);
	}
}

async function writeLocalFile(app: App, path: string, bytes: ArrayBuffer): Promise<void> {
	const norm = normalizePath(path);
	const parent = folderPathForFile(norm);
	if (parent) {
		await ensureFolderExistsOnAdapter(app, parent);
	}

	const cached = app.vault.getAbstractFileByPath(norm);
	if (cached instanceof TFile) {
		await app.vault.modifyBinary(cached, bytes);
		return;
	}

	const stat = await app.vault.adapter.stat(norm);
	if (stat?.type === "file") {
		await app.vault.adapter.writeBinary(norm, bytes);
		return;
	}

	try {
		await app.vault.createBinary(norm, bytes);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("already exists")) {
			await app.vault.adapter.writeBinary(norm, bytes);
			return;
		}
		throw err;
	}
}

export class BinarySyncManager {
	private realtimeUnsub: (() => void) | null = null;
	private readonly modifyDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly uploadsInFlight = new Set<string>();
	private readonly pendingUploadPaths = new Set<string>();
	private remoteFoldersDebounce: ReturnType<typeof setTimeout> | null = null;
	/** Paths last seen as explicitly-empty on Convex; used to prune local folders when remote removes the row. */
	private lastExplicitEmptyRemotePaths = new Set<string>();
	/** Set once we show the per-session .obsidian sync notice (prevents duplicate notices). */
	private obsidianSyncNoticeShown = false;
	/** Tracks remote text file paths so we can detect deletions (paths that disappear from metadata). */
	private lastRemoteTextPaths = new Set<string>();
	/**
	 * Paths we removed locally and told Convex to delete; metadata may still list them briefly.
	 * Do not treat "remote row exists + missing local file" as a pull until the row is gone.
	 */
	private readonly pendingLocalDeletedPaths = new Set<string>();

	constructor(
		private readonly app: App,
		private readonly httpClient: ConvexHttpClient,
		private readonly realtimeClient: ConvexClient,
		private readonly convexSecret: string,
		private readonly clientId: string,
		/** Called when remote text files are discovered (new/modified from another device). */
		private readonly onRemoteTextFilesDiscovered: (paths: string[]) => Promise<void>,
		/** Same object as plugin settings (mutated on save); read per call for live toggles. */
		private readonly pluginSettings: MyPluginSettings,
	) {}

	/** Call synchronously when the vault file is already gone locally but `removeFilesByPath` may still be in flight. */
	noteLocalDeletePending(path: string): void {
		this.pendingLocalDeletedPaths.add(normalizePath(path));
	}

	private releasePendingDeletesAckedByRemote(files: readonly { path: string }[]): void {
		const remotePaths = new Set(files.map((f) => normalizePath(f.path)));
		for (const p of [...this.pendingLocalDeletedPaths]) {
			if (!remotePaths.has(p)) {
				this.pendingLocalDeletedPaths.delete(p);
			}
		}
	}

	async start(): Promise<void> {
		// ----- offline catch-up -----
		const lastServerTimestamp = await this.loadServerTimestamp();
		if (lastServerTimestamp > 0) {
			try {
				const changes = await this.httpClient.query(api.fileSync.listAllChangesSince, {
					convexSecret: this.convexSecret,
					sinceMs: lastServerTimestamp,
				});
				await this.applyCatchUpChanges(changes);
			} catch (err: unknown) {
				console.error("Convex vault catch-up failed", err);
			}
		} else {
			// First-ever sync: seed the hash cache with all remote binary files so we
			// don't re-download files that already match on-disk content.
			try {
				const full = await this.httpClient.query(api.fileSync.listAllMetadata, {
					convexSecret: this.convexSecret,
				});
				for (const f of full.files) {
					if (!f.isText && f.contentHash) {
						await set(hashKeyForPath(f.path), f.contentHash, obsidianConvexIdbStore);
					}
				}
			} catch (err: unknown) {
				console.error("Convex vault initial seed failed", err);
			}
		}

		// Store a fresh server timestamp as the new watermark.
		await this.saveServerTimestamp();

		// Sync folder state (handles remote empty-folder create/delete after catch-up).
		await this.syncRemoteFolders();

		// ----- realtime subscription (covers all vault files + folders) -----
		this.realtimeUnsub = this.realtimeClient.onUpdate(
			api.fileSync.listAllMetadata as FunctionReference<"query">,
			{ convexSecret: this.convexSecret },
			(remote: RemoteMetadata | undefined) => {
				void this.onRemoteMetadata(remote ?? { files: [], folders: [] });
			},
			(err: Error) => {
				console.error("Convex vault metadata subscription failed", err);
			},
		);
	}

	private async loadServerTimestamp(): Promise<number> {
		try {
			const raw = await get<number>(VAULT_SYNC_TIMESTAMP_KEY, obsidianConvexIdbStore);
			return typeof raw === "number" && raw > 0 ? raw : 0;
		} catch {
			return 0;
		}
	}

	private async saveServerTimestamp(): Promise<void> {
		try {
			const ts = await this.httpClient.query(api.fileSync.getServerTimestamp, {
				convexSecret: this.convexSecret,
			});
			await set(VAULT_SYNC_TIMESTAMP_KEY, ts.serverNowMs, obsidianConvexIdbStore);
		} catch (err: unknown) {
			console.error("Convex getServerTimestamp failed", err);
		}
	}

	private async applyCatchUpChanges(changes: RemoteMetadata): Promise<void> {
		this.releasePendingDeletesAckedByRemote(changes.files);
		const textPaths: string[] = [];
		const changedObsidianPaths = new Set<string>();

		for (const file of changes.files) {
			if (file.isText) {
				if (!this.pendingLocalDeletedPaths.has(normalizePath(file.path))) {
					textPaths.push(file.path);
				}
			} else {
				if (this.pendingLocalDeletedPaths.has(normalizePath(file.path))) {
					continue;
				}
				const changed = await this.syncBinaryFile(file);
				if (changed && this.isObsidianPath(file.path)) {
					changedObsidianPaths.add(file.path);
				}
			}
		}

		for (const folder of changes.folders) {
			if (folder.isExplicitlyEmpty) {
				const exists = await this.app.vault.adapter.exists(folder.path);
				if (!exists) {
					await this.app.vault.createFolder(folder.path).catch(() => {});
				}
			}
		}

		// Detect remote deletes (binary hash cache + text path tracking).
		const deletedObsidianPaths = await this.detectAndApplyRemoteDeletes();
		for (const path of deletedObsidianPaths) {
			changedObsidianPaths.add(path);
		}

		// Notify DocManager about remote text files discovered during catch-up.
		if (textPaths.length > 0) {
			await this.onRemoteTextFilesDiscovered(textPaths);
		}

		this.maybeNotifyObsidianSyncChanges(changedObsidianPaths);
	}

	private async onRemoteMetadata(remote: RemoteMetadata): Promise<void> {
		this.releasePendingDeletesAckedByRemote(remote.files);
		const textPaths: string[] = [];
		const currentRemoteTextPaths = new Set<string>();
		const changedObsidianPaths = new Set<string>();

		for (const file of remote.files) {
			if (file.isText) {
				const norm = normalizePath(file.path);
				currentRemoteTextPaths.add(file.path);
				const exists = this.app.vault.getAbstractFileByPath(file.path) instanceof TFile;
				if (!exists && !this.pendingLocalDeletedPaths.has(norm)) {
					textPaths.push(file.path);
				}
				continue;
			}

			if (this.pendingLocalDeletedPaths.has(normalizePath(file.path))) {
				continue;
			}

			const localHash = await get<string>(hashKeyForPath(file.path), obsidianConvexIdbStore);
			if (localHash === file.contentHash) continue;
			const changed = await this.syncBinaryFile(file);
			if (changed && this.isObsidianPath(file.path)) {
				changedObsidianPaths.add(file.path);
			}
		}

		// Detect remote text file deletions: paths that were in the last snapshot but not now.
		for (const path of this.lastRemoteTextPaths) {
			if (currentRemoteTextPaths.has(path)) continue;
			const abstract = this.app.vault.getAbstractFileByPath(path);
			if (abstract instanceof TFile) {
				await this.app.vault.delete(abstract, true).catch(() => {});
			}
		}
		this.lastRemoteTextPaths = currentRemoteTextPaths;

		const deletedObsidianPaths = await this.detectAndApplyRemoteDeletes();
		for (const path of deletedObsidianPaths) {
			changedObsidianPaths.add(path);
		}
		this.scheduleSyncRemoteFolders();

		if (textPaths.length > 0) {
			await this.onRemoteTextFilesDiscovered(textPaths);
		}

		this.maybeNotifyObsidianSyncChanges(changedObsidianPaths);
	}

	private async syncBinaryFile(file: RemoteFileMeta): Promise<boolean> {
		if (file.isText) return false;
		const result = await readRemoteFileBytes(
			this.httpClient,
			this.convexSecret,
			file.path,
			binaryTransferOpts(this.pluginSettings),
		);
		if (!result) {
			await this.app.vault.adapter.remove(file.path).catch(() => {});
			await del(hashKeyForPath(file.path), obsidianConvexIdbStore);
			return true;
		}
		await writeLocalFile(this.app, file.path, result.bytes);
		await set(hashKeyForPath(file.path), file.contentHash, obsidianConvexIdbStore);
		return true;
	}

	private async detectAndApplyRemoteDeletes(): Promise<Set<string>> {
		let full: RemoteMetadata;
		try {
			full = await this.httpClient.query(api.fileSync.listAllMetadata, {
				convexSecret: this.convexSecret,
			});
		} catch {
			return new Set<string>();
		}
		const remotePaths = new Set(full.files.map((f) => f.path));
		const deletedObsidianPaths = new Set<string>();

		// Seed text path tracking so subsequent subscription updates can detect text deletions.
		const currentRemoteTextPaths = new Set(
			full.files.filter((f) => f.isText).map((f) => f.path),
		);
		// Only seed on first run; after that onRemoteMetadata manages the set.
		if (this.lastRemoteTextPaths.size === 0) {
			this.lastRemoteTextPaths = currentRemoteTextPaths;
		}

		const allKeys = await keys(obsidianConvexIdbStore);
		for (const key of allKeys) {
			if (typeof key !== "string" || !key.startsWith(BINARY_HASH_KEY_PREFIX)) continue;
			const path = key.slice(BINARY_HASH_KEY_PREFIX.length);
			if (!remotePaths.has(path)) {
				await this.app.vault.adapter.remove(path).catch(() => {});
				await del(key, obsidianConvexIdbStore);
				if (this.isObsidianPath(path)) {
					deletedObsidianPaths.add(path);
				}
				if (isTextSyncFile(path)) {
					const abstract = this.app.vault.getAbstractFileByPath(path);
					if (abstract instanceof TFile) {
						await this.app.vault.delete(abstract, true).catch(() => {});
					}
				}
			}
		}
		return deletedObsidianPaths;
	}

	private isObsidianPath(path: string): boolean {
		return path === ".obsidian" || path.startsWith(".obsidian/");
	}

	private maybeNotifyObsidianSyncChanges(changedPaths: Set<string>): void {
		if (this.obsidianSyncNoticeShown || changedPaths.size === 0) return;
		this.obsidianSyncNoticeShown = true;
		new Notice(
			"Convex sync: sync updated .obsidian files. Restart Obsidian to apply configuration changes.",
			12000,
		);
	}

	private async syncRemoteFolders(): Promise<void> {
		const snapshot = await this.httpClient.query(api.fileSync.listAllMetadata, {
			convexSecret: this.convexSecret,
		});
		const explicitEmptyNow = new Set<string>(
			snapshot.folders
				.filter((f) => f.isExplicitlyEmpty)
				.map((f) => f.path),
		);
		const anyRemoteRowForPath = new Set<string>(snapshot.folders.map((f) => f.path));
		for (const path of explicitEmptyNow) {
			const exists = await this.app.vault.adapter.exists(path);
			if (!exists) {
				await this.app.vault.createFolder(path).catch(() => {});
			}
		}
		for (const path of this.lastExplicitEmptyRemotePaths) {
			if (explicitEmptyNow.has(path)) continue;
			if (anyRemoteRowForPath.has(path)) continue;
			const abstract = this.app.vault.getAbstractFileByPath(path);
			if (abstract instanceof TFolder && abstract.children.length === 0) {
				await this.app.vault.delete(abstract, true).catch(() => {});
			}
		}
		this.lastExplicitEmptyRemotePaths = explicitEmptyNow;
	}

	/** Folder snapshot is not on the file-hash subscription; debounce to avoid extra load on every tick. */
	private scheduleSyncRemoteFolders(): void {
		if (this.remoteFoldersDebounce) {
			clearTimeout(this.remoteFoldersDebounce);
		}
		this.remoteFoldersDebounce = setTimeout(() => {
			this.remoteFoldersDebounce = null;
			void this.syncRemoteFolders();
		}, 1500);
	}

	async onLocalFileCreated(file: TFile): Promise<void> {
		const path = normalizePath(file.path);
		if (isTextSyncFile(path)) return;
		await this.uploadPath(path, file);
	}

	async onLocalFileModified(file: TFile): Promise<void> {
		const path = normalizePath(file.path);
		if (isTextSyncFile(path)) return;
		const existing = this.modifyDebounceTimers.get(path);
		if (existing) clearTimeout(existing);
		this.modifyDebounceTimers.set(
			path,
			setTimeout(() => {
				this.modifyDebounceTimers.delete(path);
				void this.uploadPath(path, file);
			}, 800),
		);
	}

	async onLocalFileDeleted(path: string): Promise<void> {
		const norm = normalizePath(path);
		this.noteLocalDeletePending(norm);
		await del(hashKeyForPath(norm), obsidianConvexIdbStore);
		await this.httpClient.mutation(api.fileSync.removeFilesByPath, {
			convexSecret: this.convexSecret,
			removedPaths: [norm],
		});
	}

	async onLocalFileRenamed(oldPath: string, newFile: TFile): Promise<void> {
		await this.onLocalFileDeleted(oldPath);
		await this.onLocalFileCreated(newFile);
	}

	async onLocalFolderCreated(folderPath: string): Promise<void> {
		const norm = normalizePath(folderPath);
		await this.httpClient.mutation(api.fileSync.registerExplicitEmptyFolder, {
			convexSecret: this.convexSecret,
			path: norm,
			scannedAtMs: Date.now(),
			clientId: this.clientId,
		});
	}

	async onLocalFolderDeleted(folderPath: string): Promise<void> {
		await this.httpClient.mutation(api.fileSync.removeFoldersByPath, {
			convexSecret: this.convexSecret,
			removedPaths: [normalizePath(folderPath)],
		});
	}

	async onLocalFolderRenamed(oldPath: string, newPath: string): Promise<void> {
		await this.onLocalFolderDeleted(oldPath);
		await this.onLocalFolderCreated(newPath);
	}

	private async uploadPath(path: string, fallbackFile?: TFile): Promise<void> {
		if (this.uploadsInFlight.has(path)) {
			this.pendingUploadPaths.add(path);
			return;
		}
		this.uploadsInFlight.add(path);
		try {
			const abstract = this.app.vault.getAbstractFileByPath(path);
			const liveFile = abstract instanceof TFile ? abstract : fallbackFile;
			if (!liveFile || isTextSyncFile(path)) return;
			const bytes = await this.app.vault.readBinary(liveFile);
			await uploadLocalFile(
				this.httpClient,
				this.convexSecret,
				this.clientId,
				path,
				bytes,
				liveFile.stat.mtime,
				binaryTransferOpts(this.pluginSettings),
			);
		} finally {
			this.uploadsInFlight.delete(path);
			if (this.pendingUploadPaths.delete(path)) {
				void this.uploadPath(path);
			}
		}
	}

	dispose(): void {
		if (this.remoteFoldersDebounce) {
			clearTimeout(this.remoteFoldersDebounce);
			this.remoteFoldersDebounce = null;
		}
		for (const t of this.modifyDebounceTimers.values()) {
			clearTimeout(t);
		}
		this.modifyDebounceTimers.clear();
		this.uploadsInFlight.clear();
		this.pendingUploadPaths.clear();
		this.realtimeUnsub?.();
		this.realtimeUnsub = null;
	}
}
