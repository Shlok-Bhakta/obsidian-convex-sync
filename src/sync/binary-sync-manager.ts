import type { FunctionReference } from "convex/server";
import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import { del, get, keys, set } from "idb-keyval";
import { normalizePath, TFile, type App } from "obsidian";
import { api } from "../../convex/_generated/api";
import { isTextSyncFile, readRemoteFileBytes } from "../file-sync";
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

	constructor(
		private readonly app: App,
		private readonly httpClient: ConvexHttpClient,
		private readonly realtimeClient: ConvexClient,
		private readonly convexSecret: string,
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

	dispose(): void {
		this.realtimeUnsub?.();
		this.realtimeUnsub = null;
	}
}
