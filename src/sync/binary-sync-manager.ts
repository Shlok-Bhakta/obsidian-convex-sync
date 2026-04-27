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
import { isLocalChangeSuppressed, withSuppressedLocalChange } from "./local-change-suppressor";
import { obsidianConvexIdbStore } from "./yjs-local-cache";

const VAULT_SYNC_TIMESTAMP_KEY = "vaultSync:lastServerTimestamp";
const BINARY_HASH_KEY_PREFIX = "binarySync:hash:";

type RemoteFileMeta = {
	path: string;
	contentHash: string;
	updatedAtMs: number;
	updatedByClientId: string;
	isText: boolean;
};

type RemoteFolderMeta = {
	path: string;
	updatedAtMs: number;
	updatedByClientId: string;
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

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return toHex(digest);
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

	await withSuppressedLocalChange(norm, async () => {
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
	});
}

export class BinarySyncManager {
	private realtimeUnsub: (() => void) | null = null;
	private readonly modifyDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly uploadsInFlight = new Set<string>();
	private readonly pendingUploadPaths = new Set<string>();
	private readonly lastRemoteFiles = new Map<string, RemoteFileMeta>();
	private readonly pendingLocalDeletedPaths = new Set<string>();
	private lastExplicitEmptyRemotePaths = new Set<string>();
	private obsidianSyncNoticeShown = false;

	constructor(
		private readonly app: App,
		private readonly httpClient: ConvexHttpClient,
		private readonly realtimeClient: ConvexClient,
		private readonly convexSecret: string,
		private readonly clientId: string,
		private readonly onRemoteTextFilesDiscovered: (paths: string[]) => Promise<void>,
		private readonly pluginSettings: MyPluginSettings,
	) {}

	noteLocalDeletePending(path: string): void {
		this.pendingLocalDeletedPaths.add(normalizePath(path));
	}

	private releasePendingDeletesAckedByRemote(files: readonly { path: string }[]): void {
		const remotePaths = new Set(files.map((file) => normalizePath(file.path)));
		for (const path of [...this.pendingLocalDeletedPaths]) {
			if (!remotePaths.has(path)) {
				this.pendingLocalDeletedPaths.delete(path);
			}
		}
	}

	async start(): Promise<void> {
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
		}

		try {
			const full = await this.httpClient.query(api.fileSync.listAllMetadata, {
				convexSecret: this.convexSecret,
			});
			await this.seedBaselineSnapshot(full, lastServerTimestamp === 0);
		} catch (err: unknown) {
			console.error("Convex vault baseline sync failed", err);
		}

		await this.saveServerTimestamp();

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

	private async seedBaselineSnapshot(
		remote: RemoteMetadata,
		seedHashesOnly: boolean,
	): Promise<void> {
		this.lastRemoteFiles.clear();
		for (const file of remote.files) {
			this.lastRemoteFiles.set(normalizePath(file.path), {
				...file,
				path: normalizePath(file.path),
			});
			if (seedHashesOnly && !file.isText && file.contentHash) {
				await set(hashKeyForPath(file.path), file.contentHash, obsidianConvexIdbStore);
			}
		}
		await this.applyRemoteBinaryDeletes(remote.files);
		await this.applyRemoteFolderSnapshot(remote.folders);
	}

	private async applyCatchUpChanges(changes: RemoteMetadata): Promise<void> {
		this.releasePendingDeletesAckedByRemote(changes.files);
		const textPaths = new Set<string>();
		const changedObsidianPaths = new Set<string>();

		for (const file of changes.files) {
			const norm = normalizePath(file.path);
			if (file.isText) {
				if (
					!this.pendingLocalDeletedPaths.has(norm) &&
					file.updatedByClientId !== this.clientId
				) {
					textPaths.add(norm);
				}
				continue;
			}
			if (file.updatedByClientId === this.clientId) {
				await set(hashKeyForPath(norm), file.contentHash, obsidianConvexIdbStore);
				continue;
			}
			if (this.pendingLocalDeletedPaths.has(norm)) {
				continue;
			}
			const changed = await this.syncBinaryFile({ ...file, path: norm });
			if (changed && this.isObsidianPath(norm)) {
				changedObsidianPaths.add(norm);
			}
		}

		await this.applyRemoteFolderSnapshot(changes.folders);

		if (textPaths.size > 0) {
			await this.onRemoteTextFilesDiscovered([...textPaths]);
		}
		this.maybeNotifyObsidianSyncChanges(changedObsidianPaths);
	}

	private async onRemoteMetadata(remote: RemoteMetadata): Promise<void> {
		this.releasePendingDeletesAckedByRemote(remote.files);
		const nextRemoteFiles = new Map<string, RemoteFileMeta>();
		const textPaths = new Set<string>();
		const changedObsidianPaths = new Set<string>();

		for (const file of remote.files) {
			const norm = normalizePath(file.path);
			const normalizedFile = { ...file, path: norm };
			nextRemoteFiles.set(norm, normalizedFile);
			const previous = this.lastRemoteFiles.get(norm);
			const changed =
				previous === undefined ||
				previous.contentHash !== normalizedFile.contentHash ||
				previous.updatedAtMs !== normalizedFile.updatedAtMs;

			if (normalizedFile.isText) {
				if (
					changed &&
					normalizedFile.updatedByClientId !== this.clientId &&
					!this.pendingLocalDeletedPaths.has(norm)
				) {
					textPaths.add(norm);
				}
				continue;
			}

			const cachedHash = await get<string>(hashKeyForPath(norm), obsidianConvexIdbStore);
			if (normalizedFile.updatedByClientId === this.clientId) {
				await set(hashKeyForPath(norm), normalizedFile.contentHash, obsidianConvexIdbStore);
				continue;
			}
			if (cachedHash === normalizedFile.contentHash) {
				continue;
			}
			if (!changed || this.pendingLocalDeletedPaths.has(norm)) {
				continue;
			}
			const didChange = await this.syncBinaryFile(normalizedFile);
			if (didChange && this.isObsidianPath(norm)) {
				changedObsidianPaths.add(norm);
			}
		}

		for (const [path, previous] of this.lastRemoteFiles) {
			if (nextRemoteFiles.has(path)) {
				continue;
			}
			await this.applyRemoteDelete(previous);
			if (this.isObsidianPath(path)) {
				changedObsidianPaths.add(path);
			}
		}

		this.lastRemoteFiles.clear();
		for (const [path, file] of nextRemoteFiles) {
			this.lastRemoteFiles.set(path, file);
		}

		await this.applyRemoteFolderSnapshot(remote.folders);

		if (textPaths.size > 0) {
			await this.onRemoteTextFilesDiscovered([...textPaths]);
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
			await this.applyRemoteDelete(file);
			return true;
		}
		await writeLocalFile(this.app, file.path, result.bytes);
		await set(hashKeyForPath(file.path), file.contentHash, obsidianConvexIdbStore);
		return true;
	}

	private async applyRemoteDelete(file: Pick<RemoteFileMeta, "path" | "isText">): Promise<void> {
		const norm = normalizePath(file.path);
		if (file.isText) {
			const abstract = this.app.vault.getAbstractFileByPath(norm);
			if (abstract instanceof TFile) {
				await withSuppressedLocalChange(norm, async () => {
					await this.app.vault.delete(abstract, true).catch(() => {});
				});
			}
			return;
		}
		await withSuppressedLocalChange(norm, async () => {
			await this.app.vault.adapter.remove(norm).catch(() => {});
		});
		await del(hashKeyForPath(norm), obsidianConvexIdbStore);
	}

	private async applyRemoteBinaryDeletes(files: readonly RemoteFileMeta[]): Promise<void> {
		const remoteBinaryPaths = new Set(
			files.filter((file) => !file.isText).map((file) => normalizePath(file.path)),
		);
		for (const key of await keys(obsidianConvexIdbStore)) {
			if (typeof key !== "string" || !key.startsWith(BINARY_HASH_KEY_PREFIX)) {
				continue;
			}
			const path = key.slice(BINARY_HASH_KEY_PREFIX.length);
			if (remoteBinaryPaths.has(path)) {
				continue;
			}
			await withSuppressedLocalChange(path, async () => {
				await this.app.vault.adapter.remove(path).catch(() => {});
			});
			await del(key, obsidianConvexIdbStore);
		}
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

	private async applyRemoteFolderSnapshot(folders: readonly RemoteFolderMeta[]): Promise<void> {
		const explicitEmptyNow = new Set(
			folders.filter((folder) => folder.isExplicitlyEmpty).map((folder) => normalizePath(folder.path)),
		);
		const anyRemoteRowForPath = new Set(
			folders.map((folder) => normalizePath(folder.path)),
		);

		for (const path of explicitEmptyNow) {
			const exists = await this.app.vault.adapter.exists(path);
			if (!exists) {
				await withSuppressedLocalChange(path, async () => {
					await this.app.vault.createFolder(path).catch(() => {});
				});
			}
		}

		for (const path of this.lastExplicitEmptyRemotePaths) {
			if (explicitEmptyNow.has(path) || anyRemoteRowForPath.has(path)) {
				continue;
			}
			const abstract = this.app.vault.getAbstractFileByPath(path);
			if (abstract instanceof TFolder && abstract.children.length === 0) {
				await withSuppressedLocalChange(path, async () => {
					await this.app.vault.delete(abstract, true).catch(() => {});
				});
			}
		}

		this.lastExplicitEmptyRemotePaths = explicitEmptyNow;
	}

	async onLocalFileCreated(file: TFile): Promise<void> {
		const path = normalizePath(file.path);
		if (isTextSyncFile(path) || isLocalChangeSuppressed(path)) return;
		await this.uploadPath(path, file);
	}

	async onLocalFileModified(file: TFile): Promise<void> {
		const path = normalizePath(file.path);
		if (isTextSyncFile(path) || isLocalChangeSuppressed(path)) return;
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
		if (isLocalChangeSuppressed(norm)) {
			return;
		}
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
		if (isLocalChangeSuppressed(norm)) {
			return;
		}
		await this.httpClient.mutation(api.fileSync.registerExplicitEmptyFolder, {
			convexSecret: this.convexSecret,
			path: norm,
			scannedAtMs: Date.now(),
			clientId: this.clientId,
		});
	}

	async onLocalFolderDeleted(folderPath: string): Promise<void> {
		const norm = normalizePath(folderPath);
		if (isLocalChangeSuppressed(norm)) {
			return;
		}
		await this.httpClient.mutation(api.fileSync.removeFoldersByPath, {
			convexSecret: this.convexSecret,
			removedPaths: [norm],
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
			await set(hashKeyForPath(path), await sha256Bytes(bytes), obsidianConvexIdbStore);
		} finally {
			this.uploadsInFlight.delete(path);
			if (this.pendingUploadPaths.delete(path)) {
				void this.uploadPath(path);
			}
		}
	}

	dispose(): void {
		for (const timer of this.modifyDebounceTimers.values()) {
			clearTimeout(timer);
		}
		this.modifyDebounceTimers.clear();
		this.uploadsInFlight.clear();
		this.pendingUploadPaths.clear();
		this.realtimeUnsub?.();
		this.realtimeUnsub = null;
	}
}
