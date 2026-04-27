import type { FunctionReference } from "convex/server";
import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import { del, get, keys, set } from "idb-keyval";
import { normalizePath, TFile, TFolder, type App } from "obsidian";
import { api } from "../../convex/_generated/api";
import { isTextSyncFile, readRemoteFileBytes, uploadLocalFile } from "../file-sync";
import { obsidianConvexIdbStore } from "./yjs-local-cache";

const BINARY_SYNC_CURSOR_KEY = "binarySync:cursor";
const BINARY_HASH_KEY_PREFIX = "binarySync:hash:";

type BinarySyncCursor = { ms: number; path: string };

function normalizeBinarySyncCursor(raw: unknown): BinarySyncCursor {
	if (raw && typeof raw === "object" && "ms" in raw && typeof (raw as BinarySyncCursor).ms === "number") {
		const o = raw as BinarySyncCursor;
		return { ms: o.ms, path: typeof o.path === "string" ? o.path : "" };
	}
	if (typeof raw === "number") {
		return { ms: raw, path: "" };
	}
	return { ms: 0, path: "" };
}

type RemoteFileMeta = {
	path: string;
	contentHash: string;
	updatedAtMs: number;
};

function hashKeyForPath(path: string): string {
	return `${BINARY_HASH_KEY_PREFIX}${path}`;
}

function folderPathForFile(filePath: string): string | null {
	const slash = filePath.lastIndexOf("/");
	if (slash < 0) {
		return null;
	}
	return filePath.slice(0, slash);
}

/** Uses the vault adapter so we match on-disk state; avoids createFolder() throwing when the tree is not fully in the metadata cache yet. */
async function ensureFolderExistsOnAdapter(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (!normalized) {
		return;
	}
	if (await app.vault.adapter.exists(normalized)) {
		return;
	}
	const parent = folderPathForFile(normalized);
	if (parent) {
		await ensureFolderExistsOnAdapter(app, parent);
	}
	try {
		await app.vault.adapter.mkdir(normalized);
	} catch {
		if (await app.vault.adapter.exists(normalized)) {
			return;
		}
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

	constructor(
		private readonly app: App,
		private readonly httpClient: ConvexHttpClient,
		private readonly realtimeClient: ConvexClient,
		private readonly convexSecret: string,
		private readonly clientId: string,
	) {}

	async start(): Promise<void> {
		const cursor = normalizeBinarySyncCursor(await get(BINARY_SYNC_CURSOR_KEY, obsidianConvexIdbStore));
		const missed = await this.httpClient.query(api.fileSync.listFilesChangedSince, {
			convexSecret: this.convexSecret,
			sinceMs: cursor.ms,
			sincePath: cursor.path === "" ? undefined : cursor.path,
		});
		const sorted = [...missed].sort((a, b) => a.updatedAtMs - b.updatedAtMs);
		for (const file of sorted) {
			await this.syncFile(file);
		}

		await this.syncRemoteFolders();

		this.realtimeUnsub = this.realtimeClient.onUpdate(
			api.fileSync.listFileHashes as FunctionReference<"query">,
			{ convexSecret: this.convexSecret },
			(remoteFiles: RemoteFileMeta[] | undefined) => {
				void this.onRemoteFileList(remoteFiles ?? []);
			},
			(err: Error) => {
				console.error("Convex binary file hash subscription failed", err);
			},
		);
	}

	private async syncRemoteFolders(): Promise<void> {
		const snapshot = await this.httpClient.query(api.fileSync.listSnapshot, {
			convexSecret: this.convexSecret,
		});
		const explicitEmptyNow = new Set<string>(
			snapshot.folders
				.filter((f: { isExplicitlyEmpty: boolean }) => f.isExplicitlyEmpty)
				.map((f: { path: string }) => f.path),
		);
		const anyRemoteRowForPath = new Set<string>(
			snapshot.folders.map((f: { path: string }) => f.path),
		);
		for (const path of explicitEmptyNow) {
			const exists = await this.app.vault.adapter.exists(path);
			if (!exists) {
				await this.app.vault.createFolder(path).catch(() => {});
			}
		}
		for (const path of this.lastExplicitEmptyRemotePaths) {
			if (explicitEmptyNow.has(path)) continue;
			// Row may still exist with isExplicitlyEmpty false after a full vault scan — do not delete.
			if (anyRemoteRowForPath.has(path)) continue;
			const abstract = this.app.vault.getAbstractFileByPath(path);
			if (abstract instanceof TFolder && abstract.children.length === 0) {
				await this.app.vault.delete(abstract, true).catch(() => {});
			}
		}
		this.lastExplicitEmptyRemotePaths = explicitEmptyNow;
	}

	private async onRemoteFileList(remoteFiles: RemoteFileMeta[]): Promise<void> {
		const binaryOnly = remoteFiles.filter((f) => !isTextSyncFile(f.path));
		for (const file of binaryOnly) {
			const localHash = await get<string>(hashKeyForPath(file.path), obsidianConvexIdbStore);
			if (localHash === file.contentHash) {
				continue;
			}
			await this.syncFile(file);
		}
		await this.applyRemoteDeletes(binaryOnly);
		this.scheduleSyncRemoteFolders();
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

	private async applyRemoteDeletes(remoteFiles: RemoteFileMeta[]): Promise<void> {
		const remotePaths = new Set(remoteFiles.map((f) => f.path));
		const allKeys = await keys(obsidianConvexIdbStore);
		for (const key of allKeys) {
			if (typeof key !== "string" || !key.startsWith(BINARY_HASH_KEY_PREFIX)) {
				continue;
			}
			const path = key.slice(BINARY_HASH_KEY_PREFIX.length);
			if (isTextSyncFile(path)) {
				await del(key, obsidianConvexIdbStore);
				continue;
			}
			if (!remotePaths.has(path)) {
				await this.app.vault.adapter.remove(path).catch(() => {});
				await del(key, obsidianConvexIdbStore);
			}
		}
	}

	private async syncFile(file: RemoteFileMeta): Promise<void> {
		if (isTextSyncFile(file.path)) {
			return;
		}
		const result = await readRemoteFileBytes(this.httpClient, this.convexSecret, file.path);
		if (!result) {
			await this.app.vault.adapter.remove(file.path).catch(() => {});
			await del(hashKeyForPath(file.path), obsidianConvexIdbStore);
			return;
		}
		await writeLocalFile(this.app, file.path, result.bytes);

		await set(hashKeyForPath(file.path), file.contentHash, obsidianConvexIdbStore);
		await set(
			BINARY_SYNC_CURSOR_KEY,
			{ ms: file.updatedAtMs, path: file.path } satisfies BinarySyncCursor,
			obsidianConvexIdbStore,
		);
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
			if (!liveFile || isTextSyncFile(path)) {
				return;
			}
			const bytes = await this.app.vault.readBinary(liveFile);
			await uploadLocalFile(
				this.httpClient,
				this.convexSecret,
				this.clientId,
				path,
				bytes,
				liveFile.stat.mtime,
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
