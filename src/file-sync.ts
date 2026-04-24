import { ConvexHttpClient } from "convex/browser";
import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { MyPluginSettings } from "./settings";
import { detectContentKind, type ContentKind } from "./sync/binary";
import { resolveClientId } from "./sync/client-id";
import { getConfigDir, parseIgnoreRules, shouldSyncPath } from "./sync/policy";
import { getSyncStateStore, type SyncFileMetadata, type SyncStateStore } from "./sync/state-store";
import { collectSymlinkedPaths } from "./sync/symlinks";

export type FileSyncHost = {
	app: App;
	settings: MyPluginSettings;
	getConvexHttpClient(): ConvexHttpClient;
	getPresenceSessionId(): string;
	recordSyncDebug?(area: string, message: string, data?: Record<string, unknown>): void;
	reportSyncProgress?: (status: {
		phase: string;
		completed: number;
		total: number;
	}) => void;
};

type App = import("obsidian").App;

type SyncScanContext = {
	configDir: string;
	ignoredPaths: string[];
	symlinkedPaths: Set<string>;
	syncDotObsidian: boolean;
};

type LocalFileEntry = {
	path: string;
	updatedAtMs: number;
	readBytes: () => Promise<ArrayBuffer>;
};

type RemoteManifest = {
	fileId: string;
	path: string;
	revision: number;
	deleted: boolean;
	contentHash: string | null;
	sizeBytes: number | null;
	contentKind: ContentKind | null;
	updatedAtMs: number;
	updatedByClientId: string;
	latestSnapshotRevision: number | null;
};

type RemoteChange = {
	cursor: number;
	fileId: string;
	revision: number;
	kind: "upsert" | "rename" | "delete";
	path: string;
	previousPath: string | null;
	contentHash: string | null;
	sizeBytes: number | null;
	contentKind: ContentKind | null;
	clientId: string;
	createdAtMs: number;
};

type RemoteDelta = {
	mode: "snapshot" | "ops";
	manifest: RemoteManifest;
	snapshot: {
		revision: number;
		path: string;
		contentHash: string;
		sizeBytes: number;
		contentKind: ContentKind;
		url: string | null;
	} | null;
	ops: Array<{
		revision: number;
		kind: "upsert" | "rename" | "delete";
		path: string;
		previousPath: string | null;
		contentHash: string | null;
		sizeBytes: number | null;
		contentKind: ContentKind | null;
		url: string | null;
		createdAtMs: number;
	}>;
};

type CommitResponse =
	| {
		status: "committed";
		fileId: string;
		revision: number;
		cursor: number;
		path: string;
		manifest: RemoteManifest;
		merged?: boolean;
		mergedText?: string;
	}
	| {
		status: "conflict";
		conflictId: string;
		fileId: string;
		headRevision: number;
		path: string;
	};

export function hasSameCachedContent(
	metadata: Pick<SyncFileMetadata, "contentHash"> | null,
	contentHash: string,
): boolean {
	return metadata?.contentHash === contentHash;
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

function folderPathForFile(filePath: string): string | null {
	const slash = filePath.lastIndexOf("/");
	if (slash < 0) {
		return null;
	}
	return filePath.slice(0, slash);
}

function isObsidianPath(path: string, configDir: string): boolean {
	return path === configDir || path.startsWith(`${configDir}/`);
}

async function ensureVaultFolderExists(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (!normalized) {
		return;
	}
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFolder) {
		return;
	}
	const parent = folderPathForFile(normalized);
	if (parent) {
		await ensureVaultFolderExists(app, parent);
	}
	await app.vault.createFolder(normalized);
}

async function ensureAdapterFolderExists(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (!normalized) {
		return;
	}
	const exists = await app.vault.adapter.exists(normalized);
	if (exists) {
		return;
	}
	const parent = folderPathForFile(normalized);
	if (parent) {
		await ensureAdapterFolderExists(app, parent);
	}
	await app.vault.adapter.mkdir(normalized);
}

async function ensureLocalFolderExists(
	app: App,
	path: string,
	configDir: string,
): Promise<void> {
	if (isObsidianPath(path, configDir)) {
		await ensureAdapterFolderExists(app, path);
		return;
	}
	await ensureVaultFolderExists(app, path);
}

async function createSyncScanContext(
	host: Pick<FileSyncHost, "app" | "settings">,
): Promise<SyncScanContext> {
	const configDir = getConfigDir(host.app);
	const ignoredPaths = parseIgnoreRules(host.settings, configDir);
	const symlinkedPaths = await collectSymlinkedPaths(host.app, host.settings);
	return {
		configDir,
		ignoredPaths,
		symlinkedPaths,
		syncDotObsidian: host.settings.syncDotObsidian,
	};
}

function isPathInScope(path: string, context: SyncScanContext): boolean {
	return shouldSyncPath({
		path,
		configDir: context.configDir,
		ignoredPaths: context.ignoredPaths,
		syncDotObsidian: context.syncDotObsidian,
		symlinkedPaths: context.symlinkedPaths,
	});
}

async function collectConfigEntries(
	app: App,
	context: SyncScanContext,
): Promise<LocalFileEntry[]> {
	if (!context.syncDotObsidian) {
		return [];
	}
	const rootExists = await app.vault.adapter.exists(context.configDir);
	if (!rootExists) {
		return [];
	}
	const files: LocalFileEntry[] = [];
	const queue: string[] = [context.configDir];
	const visited = new Set<string>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || visited.has(current) || !isPathInScope(current, context)) {
			continue;
		}
		visited.add(current);
		const listed = await app.vault.adapter.list(current);
		for (const filePath of listed.files) {
			const normalizedPath = normalizePath(filePath);
			if (!isPathInScope(normalizedPath, context)) {
				continue;
			}
			const stat = await app.vault.adapter.stat(normalizedPath);
			if (!stat || stat.type !== "file") {
				continue;
			}
			files.push({
				path: normalizedPath,
				updatedAtMs: stat.mtime,
				readBytes: () => app.vault.adapter.readBinary(normalizedPath),
			});
		}
		for (const folderPath of listed.folders) {
			queue.push(normalizePath(folderPath));
		}
	}
	return files;
}

async function listLocalEntries(
	host: FileSyncHost,
	context: SyncScanContext,
): Promise<LocalFileEntry[]> {
	const vaultFiles = host.app.vault
		.getAllLoadedFiles()
		.filter((entry): entry is TFile => entry instanceof TFile)
		.filter((file) =>
			shouldSyncPath({
				path: file.path,
				configDir: context.configDir,
				ignoredPaths: context.ignoredPaths,
				syncDotObsidian: false,
				symlinkedPaths: context.symlinkedPaths,
			}),
		)
		.map<LocalFileEntry>((file) => ({
			path: normalizePath(file.path),
			updatedAtMs: file.stat.mtime,
			readBytes: () => host.app.vault.readBinary(file),
		}));
	const configFiles = await collectConfigEntries(host.app, context);
	const byPath = new Map<string, LocalFileEntry>();
	for (const entry of [...vaultFiles, ...configFiles]) {
		byPath.set(entry.path, entry);
	}
	return [...byPath.values()];
}

async function readLocalPathSnapshot(
	app: App,
	path: string,
	context: SyncScanContext,
): Promise<{ bytes: ArrayBuffer; updatedAtMs: number } | null> {
	const normalizedPath = normalizePath(path);
	if (!isPathInScope(normalizedPath, context)) {
		return null;
	}
	if (isObsidianPath(normalizedPath, context.configDir)) {
		const stat = await app.vault.adapter.stat(normalizedPath);
		if (!stat || stat.type !== "file") {
			return null;
		}
		const bytes = await app.vault.adapter.readBinary(normalizedPath);
		return { bytes, updatedAtMs: stat.mtime };
	}
	const file = app.vault.getFileByPath(normalizedPath);
	if (!file) {
		return null;
	}
	const bytes = await app.vault.readBinary(file);
	return { bytes, updatedAtMs: file.stat.mtime };
}

function toMetadata(manifest: RemoteManifest): SyncFileMetadata {
	return {
		fileId: manifest.fileId,
		path: manifest.path,
		revision: manifest.revision,
		deleted: manifest.deleted,
		updatedAtMs: manifest.updatedAtMs,
		contentHash: manifest.contentHash,
		contentKind: manifest.contentKind,
	};
}

async function downloadBytes(url: string): Promise<ArrayBuffer> {
	const response = await fetch(url, { method: "GET", cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Failed downloading file bytes: HTTP ${response.status}`);
	}
	return await response.arrayBuffer();
}

async function applyRemoteBytes(
	host: FileSyncHost,
	path: string,
	bytes: ArrayBuffer,
	contentKind: ContentKind,
): Promise<void> {
	const normalizedPath = normalizePath(path);
	const configDir = getConfigDir(host.app);
	const parent = folderPathForFile(normalizedPath);
	if (parent) {
		await ensureLocalFolderExists(host.app, parent, configDir);
	}
	if (isObsidianPath(normalizedPath, configDir)) {
		await host.app.vault.adapter.writeBinary(normalizedPath, bytes);
		return;
	}
	if (contentKind === "text") {
		const text = new TextDecoder().decode(bytes);
		const existing = host.app.vault.getFileByPath(normalizedPath);
		if (existing) {
			await host.app.vault.modify(existing, text);
			return;
		}
		await host.app.vault.create(normalizedPath, text);
		return;
	}
	const existing = host.app.vault.getFileByPath(normalizedPath);
	if (existing) {
		await host.app.vault.modifyBinary(existing, bytes);
		return;
	}
	await host.app.vault.createBinary(normalizedPath, bytes);
}

async function getLocalContentHash(
	host: FileSyncHost,
	path: string,
): Promise<string | null> {
	const context = await createSyncScanContext(host);
	const local = await readLocalPathSnapshot(host.app, path, context);
	if (!local) {
		return null;
	}
	return await sha256Bytes(local.bytes);
}

async function hasDirtyLocalChanges(
	host: FileSyncHost,
	metadata: SyncFileMetadata | null,
): Promise<boolean> {
	if (!metadata || metadata.deleted || !metadata.contentHash) {
		return false;
	}
	const localHash = await getLocalContentHash(host, metadata.path);
	return localHash !== null && localHash !== metadata.contentHash;
}

async function commitFileChange(
	host: FileSyncHost,
	store: SyncStateStore,
	args: {
		path: string;
		fileId?: string;
		bytes: ArrayBuffer;
		updatedAtMs: number;
	},
): Promise<CommitResponse> {
	const client = host.getConvexHttpClient();
	const clientId = resolveClientId(host);
	const contentHash = await sha256Bytes(args.bytes);
	const contentKind = detectContentKind(args.bytes);
	const blob = new Blob([args.bytes], { type: "application/octet-stream" });
	const metadata = args.fileId
		? await store.getMetadataByFileId(args.fileId)
		: await store.getMetadataByPath(args.path);
	const issued = await (client.mutation as any)("fileSync:issueUploadUrl", {
		convexSecret: host.settings.convexSecret,
		path: args.path,
		fileId: args.fileId,
		contentHash,
		updatedAtMs: args.updatedAtMs,
		sizeBytes: blob.size,
		clientId,
	});
	const uploadResponse = await fetch(issued.uploadUrl, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: blob,
	});
	if (!uploadResponse.ok) {
		throw new Error(`Upload failed for ${args.path}: HTTP ${uploadResponse.status}`);
	}
	const uploadPayload = (await uploadResponse.json()) as { storageId?: string };
	if (!uploadPayload.storageId) {
		throw new Error(`Upload did not return a storageId for ${args.path}`);
	}
	return (await (client.mutation as any)("fileSync:commitFileChange", {
		convexSecret: host.settings.convexSecret,
		fileId: metadata?.fileId ?? args.fileId,
		path: args.path,
		baseRevision: metadata?.revision ?? 0,
		storageId: uploadPayload.storageId,
		contentHash,
		contentKind,
		sizeBytes: blob.size,
		clientId,
		idempotencyKey: `upsert:${metadata?.fileId ?? args.fileId ?? args.path}:${contentHash}`,
		updatedAtMs: args.updatedAtMs,
	})) as CommitResponse;
}

async function backfillLegacyFiles(host: FileSyncHost): Promise<void> {
	const client = host.getConvexHttpClient();
	let cursorPath: string | undefined;
	let pages = 0;
	for (;;) {
		pages += 1;
		const result = await (client.mutation as any)("fileSync:backfillLegacyVaultFiles", {
			convexSecret: host.settings.convexSecret,
			cursorPath,
			limit: 250,
		});
		if (result.done) {
			host.recordSyncDebug?.("sync", "legacy backfill complete", { pages });
			return;
		}
		cursorPath = result.nextCursorPath ?? undefined;
		if (!cursorPath) {
			host.recordSyncDebug?.("sync", "legacy backfill stopped without cursor", { pages });
			return;
		}
	}
}

async function scanLocalChanges(host: FileSyncHost, store: SyncStateStore): Promise<void> {
	const context = await createSyncScanContext(host);
	const localFiles = await listLocalEntries(host, context);
	const localPaths = new Set(localFiles.map((file) => file.path));
	const metadata = await store.listMetadata();
	const metadataByPath = new Map(metadata.map((row) => [row.path, row]));
	let queuedUpserts = 0;
	let queuedDeletes = 0;
	for (const file of localFiles) {
		const cached = metadataByPath.get(file.path) ?? null;
		if (cached && !cached.deleted && cached.updatedAtMs === file.updatedAtMs) {
			continue;
		}
		if (cached && !cached.deleted && cached.contentHash) {
			const bytes = await file.readBytes();
			const contentHash = await sha256Bytes(bytes);
			if (hasSameCachedContent(cached, contentHash)) {
				await store.putMetadata({ ...cached, updatedAtMs: file.updatedAtMs });
				continue;
			}
		}
		await store.queueUpsert({
			fileId: cached?.fileId,
			path: file.path,
			updatedAtMs: file.updatedAtMs,
		});
		queuedUpserts += 1;
	}
	for (const row of metadata) {
		if (!row.deleted && !localPaths.has(row.path)) {
			await store.queueDelete({
				fileId: row.fileId,
				path: row.path,
				updatedAtMs: Date.now(),
			});
			queuedDeletes += 1;
		}
	}
	host.recordSyncDebug?.("sync", "local scan complete", {
		localFiles: localFiles.length,
		metadataRows: metadata.length,
		queuedUpserts,
		queuedDeletes,
	});
}

async function reportCursor(host: FileSyncHost, cursor: number): Promise<void> {
	await (host.getConvexHttpClient().mutation as any)("fileSync:reportClientCursor", {
		convexSecret: host.settings.convexSecret,
		clientId: resolveClientId(host),
		cursor,
	});
}

async function flushOutbox(host: FileSyncHost, store: SyncStateStore): Promise<number | null> {
	let latestCommittedCursor: number | null = null;
	const entries = await store.listOutbox();
	let committed = 0;
	let conflicts = 0;
	let skipped = 0;
	host.recordSyncDebug?.("sync", "outbox flush started", { entries: entries.length });
	for (const entry of entries) {
		if (entry.kind === "upsert") {
			const context = await createSyncScanContext(host);
			const metadata = entry.fileId
				? await store.getMetadataByFileId(entry.fileId)
				: await store.getMetadataByPath(entry.path);
			const local = entry.textContent
				? {
					bytes: new TextEncoder().encode(entry.textContent).buffer as ArrayBuffer,
					updatedAtMs: entry.updatedAtMs,
				}
				: await readLocalPathSnapshot(host.app, entry.path, context);
			if (!local) {
				if (metadata && !metadata.deleted) {
					await store.queueDelete({
						fileId: metadata.fileId,
						path: metadata.path,
						updatedAtMs: Date.now(),
					});
				}
				await store.deleteOutbox(entry.opId);
				skipped += 1;
				continue;
			}
			if (metadata && !metadata.deleted && metadata.contentHash) {
				const contentHash = await sha256Bytes(local.bytes);
				if (hasSameCachedContent(metadata, contentHash)) {
					await store.putMetadata({ ...metadata, updatedAtMs: local.updatedAtMs });
					await store.deleteOutbox(entry.opId);
					skipped += 1;
					continue;
				}
			}
			const result = await commitFileChange(host, store, {
				path: entry.path,
				fileId: entry.fileId,
				bytes: local.bytes,
				updatedAtMs: local.updatedAtMs,
			});
			if (result.status === "committed") {
				if (result.merged && result.mergedText !== undefined) {
					const bytes = new TextEncoder().encode(result.mergedText).buffer as ArrayBuffer;
					await applyRemoteBytes(host, result.manifest.path, bytes, "text");
				}
				await store.putMetadata(toMetadata(result.manifest));
				await store.setLastSeenCursor(result.cursor);
				latestCommittedCursor = Math.max(latestCommittedCursor ?? 0, result.cursor);
				committed += 1;
			} else {
				conflicts += 1;
				new Notice(`Convex sync conflict for ${result.path}`, 8000);
				await store.deleteOutbox(entry.opId);
				await store.queueUpsert({
					fileId: metadata?.fileId ?? entry.fileId,
					path: entry.path,
					textContent: entry.textContent,
					updatedAtMs: entry.updatedAtMs,
				});
				continue;
			}
			await store.deleteOutbox(entry.opId);
			continue;
		}

		const metadata = entry.fileId
			? await store.getMetadataByFileId(entry.fileId)
			: await store.getMetadataByPath(entry.path);
		if (!metadata) {
			await store.deleteOutbox(entry.opId);
			skipped += 1;
			continue;
		}

		if (entry.kind === "rename") {
			const result = (await (host.getConvexHttpClient().mutation as any)("fileSync:commitRename", {
				convexSecret: host.settings.convexSecret,
				fileId: metadata.fileId,
				newPath: entry.newPath,
				baseRevision: metadata.revision,
				clientId: resolveClientId(host),
				idempotencyKey: `rename:${metadata.fileId}:${entry.newPath}`,
				updatedAtMs: entry.updatedAtMs,
			})) as CommitResponse;
			if (result.status === "committed") {
				await store.putMetadata(toMetadata(result.manifest));
				await store.setLastSeenCursor(result.cursor);
				latestCommittedCursor = Math.max(latestCommittedCursor ?? 0, result.cursor);
				committed += 1;
			} else {
				conflicts += 1;
				new Notice(`Convex sync rename conflict for ${result.path}`, 8000);
			}
			await store.deleteOutbox(entry.opId);
			continue;
		}

		if (metadata.deleted) {
			await store.deleteOutbox(entry.opId);
			skipped += 1;
			continue;
		}
		const result = (await (host.getConvexHttpClient().mutation as any)("fileSync:commitDelete", {
			convexSecret: host.settings.convexSecret,
			fileId: metadata.fileId,
			baseRevision: metadata.revision,
			clientId: resolveClientId(host),
			idempotencyKey: `delete:${metadata.fileId}:${metadata.revision}`,
			updatedAtMs: entry.updatedAtMs,
		})) as CommitResponse;
		if (result.status === "committed") {
			await store.putMetadata(toMetadata(result.manifest));
			await store.setLastSeenCursor(result.cursor);
			latestCommittedCursor = Math.max(latestCommittedCursor ?? 0, result.cursor);
			committed += 1;
		} else {
			conflicts += 1;
			new Notice(`Convex sync delete conflict for ${result.path}`, 8000);
		}
		await store.deleteOutbox(entry.opId);
	}
	host.recordSyncDebug?.("sync", "outbox flush finished", {
		entries: entries.length,
		committed,
		conflicts,
		skipped,
		latestCommittedCursor,
	});
	return latestCommittedCursor;
}

async function applyRemoteDelta(host: FileSyncHost, store: SyncStateStore, delta: RemoteDelta): Promise<void> {
	const existing = await store.getMetadataByFileId(delta.manifest.fileId);
	if (await hasDirtyLocalChanges(host, existing)) {
		await store.queueUpsert({
			fileId: existing?.fileId,
			path: existing?.path ?? delta.manifest.path,
			updatedAtMs: Date.now(),
		});
		return;
	}
	if (delta.manifest.deleted) {
		if (existing) {
			await applyRemoteDelete(host, existing.path);
		}
		await store.putMetadata(toMetadata(delta.manifest));
		return;
	}

	const latestWithBytes =
		delta.mode === "snapshot"
			? delta.snapshot
			: [...delta.ops].reverse().find((op) => op.url && op.kind === "upsert") ?? delta.snapshot;
	if (existing && existing.path !== delta.manifest.path) {
		await applyRemoteRename(host, existing.path, delta.manifest.path);
	}
	if (latestWithBytes?.url && latestWithBytes.contentKind) {
		const bytes = await downloadBytes(latestWithBytes.url);
		await applyRemoteBytes(host, delta.manifest.path, bytes, latestWithBytes.contentKind);
	}
	await store.putMetadata(toMetadata(delta.manifest));
}

async function syncRemoteChanges(host: FileSyncHost, store: SyncStateStore): Promise<void> {
	const client = host.getConvexHttpClient();
	const localClientId = resolveClientId(host);
	let cursor = await store.getLastSeenCursor();
	let batches = 0;
	let changesSeen = 0;
	let changesApplied = 0;
	for (;;) {
		batches += 1;
		const batchStartCursor = cursor;
		const response = (await (client.query as any)("fileSync:listChangesSince", {
			convexSecret: host.settings.convexSecret,
			cursor,
			limit: 1000,
		})) as { headCursor: number; changes: RemoteChange[] };
		if (response.changes.length === 0) {
			if (response.headCursor > cursor) {
				await store.setLastSeenCursor(response.headCursor);
				await reportCursor(host, response.headCursor);
			}
			host.recordSyncDebug?.("sync", "remote sync complete", {
				batches,
				changesSeen,
				changesApplied,
				cursor: response.headCursor,
			});
			return;
		}
		changesSeen += response.changes.length;
		for (const change of response.changes) {
			cursor = Math.max(cursor, change.cursor);
			await store.setLastSeenCursor(cursor);
			if (change.clientId === localClientId) {
				continue;
			}
			const metadata = await store.getMetadataByFileId(change.fileId);
			const delta = (await (client.query as any)("fileSync:getFileSnapshotOrOps", {
				convexSecret: host.settings.convexSecret,
				fileId: change.fileId,
				fromRevision: metadata?.revision ?? 0,
			})) as RemoteDelta | null;
			if (!delta) {
				continue;
			}
			await applyRemoteDelta(host, store, delta);
			changesApplied += 1;
		}
		if (cursor > batchStartCursor) {
			await reportCursor(host, cursor);
		}
		if (response.changes.length < 1000) {
			host.recordSyncDebug?.("sync", "remote sync complete", {
				batches,
				changesSeen,
				changesApplied,
				cursor,
			});
			return;
		}
	}
}

export async function pushVaultPathUpdate(
	host: FileSyncHost,
	path: string,
): Promise<void> {
	const secret = host.settings.convexSecret.trim();
	if (!secret) {
		return;
	}
	const context = await createSyncScanContext(host);
	const normalizedPath = normalizePath(path);
	if (!isPathInScope(normalizedPath, context)) {
		return;
	}
	const metadata = await getSyncStateStore().getMetadataByPath(normalizedPath);
	await getSyncStateStore().queueUpsert({
		fileId: metadata?.fileId,
		path: normalizedPath,
		updatedAtMs: Date.now(),
	});
}

export async function pushVaultTextUpdate(
	host: FileSyncHost,
	path: string,
	text: string,
	updatedAtMs = Date.now(),
): Promise<void> {
	const secret = host.settings.convexSecret.trim();
	if (!secret) {
		return;
	}
	const normalizedPath = normalizePath(path);
	const metadata = await getSyncStateStore().getMetadataByPath(normalizedPath);
	await getSyncStateStore().queueUpsert({
		fileId: metadata?.fileId,
		path: normalizedPath,
		textContent: text,
		updatedAtMs,
	});
}

export async function trashRemoteVaultPaths(
	host: FileSyncHost,
	paths: string[],
): Promise<void> {
	const store = getSyncStateStore();
	for (const path of paths) {
		const normalizedPath = normalizePath(path);
		const metadata = await store.getMetadataByPath(normalizedPath);
		await store.queueDelete({
			fileId: metadata?.fileId,
			path: normalizedPath,
			updatedAtMs: Date.now(),
		});
	}
}

export async function renameRemoteVaultPath(
	host: FileSyncHost,
	oldPath: string,
	newPath: string,
): Promise<void> {
	const store = getSyncStateStore();
	const metadata = await store.getMetadataByPath(oldPath);
	await store.queueRename({
		fileId: metadata?.fileId,
		path: normalizePath(oldPath),
		newPath: normalizePath(newPath),
		updatedAtMs: Date.now(),
	});
}

export async function applyRemoteVaultPath(
	host: FileSyncHost,
	path: string,
): Promise<void> {
	const normalizedPath = normalizePath(path);
	const metadata = await getSyncStateStore().getMetadataByPath(normalizedPath);
	if (!metadata) {
		return;
	}
	const delta = (await (host.getConvexHttpClient().query as any)("fileSync:getFileSnapshotOrOps", {
		convexSecret: host.settings.convexSecret,
		fileId: metadata.fileId,
		fromRevision: Math.max(0, metadata.revision - 1),
	})) as RemoteDelta | null;
	if (!delta) {
		return;
	}
	await applyRemoteDelta(host, getSyncStateStore(), delta);
}

export async function applyRemoteDelete(
	host: FileSyncHost,
	path: string,
): Promise<void> {
	const normalizedPath = normalizePath(path);
	if (isObsidianPath(normalizedPath, getConfigDir(host.app))) {
		if (await host.app.vault.adapter.exists(normalizedPath)) {
			await host.app.vault.adapter.remove(normalizedPath);
		}
		return;
	}
	const existing = host.app.vault.getAbstractFileByPath(normalizedPath);
	if (!existing) {
		return;
	}
	await host.app.vault.trash(existing, false);
}

export async function applyRemoteRename(
	host: FileSyncHost,
	oldPath: string,
	newPath: string,
): Promise<void> {
	const normalizedOldPath = normalizePath(oldPath);
	const normalizedNewPath = normalizePath(newPath);
	const configDir = getConfigDir(host.app);
	if (
		isObsidianPath(normalizedOldPath, configDir) ||
		isObsidianPath(normalizedNewPath, configDir)
	) {
		const parent = folderPathForFile(normalizedNewPath);
		if (parent) {
			await ensureAdapterFolderExists(host.app, parent);
		}
		if (await host.app.vault.adapter.exists(normalizedOldPath)) {
			await host.app.vault.adapter.rename(normalizedOldPath, normalizedNewPath);
		}
		return;
	}
	const existing = host.app.vault.getAbstractFileByPath(normalizedOldPath);
	if (!existing) {
		return;
	}
	const parent = folderPathForFile(normalizedNewPath);
	if (parent) {
		await ensureVaultFolderExists(host.app, parent);
	}
	await host.app.vault.rename(existing, normalizedNewPath);
}

export async function runVaultFileSync(host: FileSyncHost): Promise<void> {
	const url = host.settings.convexUrl.trim();
	const secret = host.settings.convexSecret.trim();
	if (!url || !secret) {
		new Notice("Convex sync: set Convex URL and secret first.", 8000);
		return;
	}
	host.recordSyncDebug?.("sync", "full sync started");
	const store = getSyncStateStore();
	host.reportSyncProgress?.({ phase: "Backfilling legacy file state", completed: 0, total: 5 });
	await backfillLegacyFiles(host);
	host.reportSyncProgress?.({ phase: "Fetching remote changes", completed: 1, total: 5 });
	await syncRemoteChanges(host, store);
	host.reportSyncProgress?.({ phase: "Scanning local files", completed: 2, total: 5 });
	await scanLocalChanges(host, store);
	host.reportSyncProgress?.({ phase: "Uploading local outbox", completed: 3, total: 5 });
	const latestCommittedCursor = await flushOutbox(host, store);
	if (latestCommittedCursor !== null) {
		await reportCursor(host, latestCommittedCursor);
	}
	host.reportSyncProgress?.({ phase: "Fetching remote changes", completed: 4, total: 5 });
	await syncRemoteChanges(host, store);
	host.reportSyncProgress?.({ phase: "Idle", completed: 5, total: 5 });
	host.recordSyncDebug?.("sync", "full sync finished");
}

export async function runRemoteFileSync(host: FileSyncHost): Promise<void> {
	const url = host.settings.convexUrl.trim();
	const secret = host.settings.convexSecret.trim();
	if (!url || !secret) {
		return;
	}
	host.recordSyncDebug?.("sync", "remote sync started");
	await syncRemoteChanges(host, getSyncStateStore());
}

export async function runQueuedFileSync(host: FileSyncHost): Promise<void> {
	const url = host.settings.convexUrl.trim();
	const secret = host.settings.convexSecret.trim();
	if (!url || !secret) {
		return;
	}
	host.recordSyncDebug?.("sync", "queued sync started");
	const store = getSyncStateStore();
	const latestCommittedCursor = await flushOutbox(host, store);
	if (latestCommittedCursor !== null) {
		await reportCursor(host, latestCommittedCursor);
	}
	await syncRemoteChanges(host, store);
	host.recordSyncDebug?.("sync", "queued sync finished");
}
