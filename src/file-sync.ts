import { ConvexHttpClient } from "convex/browser";
import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import { api } from "../convex/_generated/api";
import type { MyPluginSettings } from "./settings";
import { detectContentKind, type ContentKind } from "./sync/binary";
import { resolveClientId } from "./sync/client-id";
import { getConfigDir, parseIgnoreRules, shouldSyncPath } from "./sync/policy";
import { collectSymlinkedPaths } from "./sync/symlinks";

type FileSyncHost = {
	app: App;
	settings: MyPluginSettings;
	getConvexHttpClient(): ConvexHttpClient;
	getPresenceSessionId(): string;
	reportSyncProgress?: (status: {
		phase: string;
		completed: number;
		total: number;
	}) => void;
};

type App = import("obsidian").App;

type Snapshot = {
	files: Array<{
		path: string;
		contentHash: string;
		contentKind: ContentKind;
		sizeBytes: number;
		updatedAtMs: number;
		updatedByClientId: string;
	}>;
	folders: Array<{
		path: string;
		updatedAtMs: number;
		isExplicitlyEmpty: boolean;
		updatedByClientId: string;
	}>;
};

type LocalFileEntry = {
	path: string;
	updatedAtMs: number;
	readBytes: () => Promise<ArrayBuffer>;
};

type SyncScanContext = {
	configDir: string;
	ignoredPaths: string[];
	symlinkedPaths: Set<string>;
	syncDotObsidian: boolean;
};

const RECONCILE_CLOCK_SKEW_TOLERANCE_MS = 10 * 60 * 1000;

function isObsidianPath(path: string, configDir: string): boolean {
	return path === configDir || path.startsWith(`${configDir}/`);
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

async function readRemoteFileBytes(
	client: ConvexHttpClient,
	secret: string,
	path: string,
): Promise<{ bytes: ArrayBuffer; updatedAtMs: number; contentKind: ContentKind } | null> {
	const signed = await client.query(api.fileSync.getDownloadUrl, {
		convexSecret: secret,
		path,
	});
	if (!signed) {
		return null;
	}
	const response = await fetch(signed.url, { method: "GET", cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Failed downloading ${path}: HTTP ${response.status}`);
	}
	const bytes = await response.arrayBuffer();
	return {
		bytes,
		updatedAtMs: signed.updatedAtMs,
		contentKind: signed.contentKind as ContentKind,
	};
}

async function uploadBytesAtPath(
	settings: Pick<MyPluginSettings, "binaryVersionRetentionCount">,
	client: ConvexHttpClient,
	secret: string,
	clientId: string,
	path: string,
	bytes: ArrayBuffer,
	updatedAtMs: number,
): Promise<"ok" | "stale_write"> {
	const blob = new Blob([bytes], { type: "application/octet-stream" });
	const contentHash = await sha256Bytes(bytes);
	const contentKind = detectContentKind(bytes);
	const issued = await client.mutation(api.fileSync.issueUploadUrl, {
		convexSecret: secret,
		path,
		contentHash,
		updatedAtMs,
		sizeBytes: blob.size,
		clientId,
	});
	const uploadResponse = await fetch(issued.uploadUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/octet-stream",
		},
		body: blob,
	});
	if (!uploadResponse.ok) {
		throw new Error(`Upload failed for ${path}: HTTP ${uploadResponse.status}`);
	}
	const payload = (await uploadResponse.json()) as { storageId?: string };
	if (!payload.storageId) {
		throw new Error(`Upload did not return storageId for ${path}`);
	}
	const finalized = await client.mutation(api.fileSync.finalizeUpload, {
		convexSecret: secret,
		path,
		storageId: payload.storageId as never,
		contentHash,
		contentKind,
		updatedAtMs,
		sizeBytes: blob.size,
		clientId,
		retainBinaryVersions: settings.binaryVersionRetentionCount,
	});
	if (!finalized.ok && finalized.reason === "stale_write") {
		return "stale_write";
	}
	return "ok";
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

function listEmptyFolders(app: App, context: SyncScanContext): string[] {
	const all = app.vault.getAllLoadedFiles();
	const empty: string[] = [];
	for (const entry of all) {
		if (!(entry instanceof TFolder)) {
			continue;
		}
		if (entry.path.trim() === "") {
			continue;
		}
		if (
			!shouldSyncPath({
				path: entry.path,
				configDir: context.configDir,
				ignoredPaths: context.ignoredPaths,
				syncDotObsidian: false,
				symlinkedPaths: context.symlinkedPaths,
			})
		) {
			continue;
		}
		if (entry.children.length === 0) {
			empty.push(normalizePath(entry.path));
		}
	}
	return empty;
}

async function collectConfigEntries(
	app: App,
	context: SyncScanContext,
): Promise<{ files: LocalFileEntry[]; emptyFolders: string[] }> {
	if (!context.syncDotObsidian) {
		return { files: [], emptyFolders: [] };
	}
	const rootExists = await app.vault.adapter.exists(context.configDir);
	if (!rootExists) {
		return { files: [], emptyFolders: [] };
	}

	const files: LocalFileEntry[] = [];
	const emptyFolders: string[] = [];
	const queue: string[] = [context.configDir];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || !isPathInScope(current, context)) {
			continue;
		}
		const listed = await app.vault.adapter.list(current);
		if (listed.files.length === 0 && listed.folders.length === 0) {
			emptyFolders.push(normalizePath(current));
		}

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
	return { files, emptyFolders };
}

async function listLocalEntries(
	host: FileSyncHost,
	context: SyncScanContext,
): Promise<{
	files: LocalFileEntry[];
	emptyFolders: string[];
}> {
	const fromVault = host.app.vault
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

	const configEntries = await collectConfigEntries(host.app, context);
	const byPath = new Map<string, LocalFileEntry>();
	for (const entry of [...fromVault, ...configEntries.files]) {
		byPath.set(entry.path, entry);
	}

	return {
		files: [...byPath.values()],
		emptyFolders: [...listEmptyFolders(host.app, context), ...configEntries.emptyFolders],
	};
}

export async function pushVaultPathUpdate(
	host: FileSyncHost,
	path: string,
): Promise<void> {
	const secret = host.settings.convexSecret.trim();
	if (!secret) {
		return;
	}
	const normalizedPath = normalizePath(path);
	const context = await createSyncScanContext(host);
	const local = await readLocalPathSnapshot(host.app, normalizedPath, context);
	if (!local) {
		return;
	}
	await uploadBytesAtPath(
		host.settings,
		host.getConvexHttpClient(),
		secret,
		resolveClientId(host),
		normalizedPath,
		local.bytes,
		local.updatedAtMs,
	);
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
	const context = await createSyncScanContext(host);
	if (!isPathInScope(normalizedPath, context) || isObsidianPath(normalizedPath, context.configDir)) {
		return;
	}
	const bytes = new TextEncoder().encode(text).buffer as ArrayBuffer;
	await uploadBytesAtPath(
		host.settings,
		host.getConvexHttpClient(),
		secret,
		resolveClientId(host),
		normalizedPath,
		bytes,
		updatedAtMs,
	);
}

export async function trashRemoteVaultPaths(
	host: FileSyncHost,
	paths: string[],
): Promise<void> {
	if (paths.length === 0) {
		return;
	}
	const secret = host.settings.convexSecret.trim();
	if (!secret) {
		return;
	}
	await host.getConvexHttpClient().mutation(api.fileSync.removeFilesByPath, {
		convexSecret: secret,
		removedPaths: paths.map((path) => normalizePath(path)),
		clientId: resolveClientId(host),
		deletedAtMs: Date.now(),
		trashRetentionDays: host.settings.trashRetentionDays,
	});
}

export async function renameRemoteVaultPath(
	host: FileSyncHost,
	oldPath: string,
	newPath: string,
): Promise<void> {
	const secret = host.settings.convexSecret.trim();
	if (!secret) {
		return;
	}
	await host.getConvexHttpClient().mutation(api.fileSync.renamePath, {
		convexSecret: secret,
		oldPath: normalizePath(oldPath),
		newPath: normalizePath(newPath),
		clientId: resolveClientId(host),
		updatedAtMs: Date.now(),
	});
}

export async function applyRemoteVaultPath(
	host: FileSyncHost,
	path: string,
): Promise<void> {
	const secret = host.settings.convexSecret.trim();
	if (!secret) {
		return;
	}
	const normalizedPath = normalizePath(path);
	const remote = await readRemoteFileBytes(
		host.getConvexHttpClient(),
		secret,
		normalizedPath,
	);
	if (!remote) {
		return;
	}
	const parent = folderPathForFile(normalizedPath);
	if (parent) {
		await ensureLocalFolderExists(host.app, parent, getConfigDir(host.app));
	}

	if (isObsidianPath(normalizedPath, getConfigDir(host.app))) {
		await host.app.vault.adapter.writeBinary(normalizedPath, remote.bytes);
		return;
	}

	if (remote.contentKind === "text") {
		const text = new TextDecoder().decode(remote.bytes);
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
		await host.app.vault.modifyBinary(existing, remote.bytes);
		return;
	}
	await host.app.vault.createBinary(normalizedPath, remote.bytes);
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
			return;
		}
		await applyRemoteVaultPath(host, normalizedNewPath);
		return;
	}

	const existing = host.app.vault.getAbstractFileByPath(normalizedOldPath);
	if (!existing) {
		await applyRemoteVaultPath(host, normalizedNewPath);
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

	const client = host.getConvexHttpClient();
	const clientId = resolveClientId(host);
	const context = await createSyncScanContext(host);
	await client.mutation(api.fileSync.repairFutureTimestamps, {
		convexSecret: secret,
	});
	host.reportSyncProgress?.({
		phase: "Preparing snapshot",
		completed: 0,
		total: 1,
	});
	const snapshot = (await client.query(api.fileSync.listSnapshot, {
		convexSecret: secret,
	})) as Snapshot;
	const remoteFiles = snapshot.files.filter((row) => isPathInScope(row.path, context));
	const remoteByPath = new Map(remoteFiles.map((row) => [row.path, row]));
	for (const remoteFolder of snapshot.folders) {
		if (!remoteFolder.isExplicitlyEmpty || !isPathInScope(remoteFolder.path, context)) {
			continue;
		}
		await ensureLocalFolderExists(host.app, remoteFolder.path, context.configDir);
	}

	const localState = await listLocalEntries(host, context);
	const localFiles = localState.files;
	const totalSteps = localFiles.length + remoteFiles.length + 1;
	let completedSteps = 0;
	const tick = (phase: string): void => {
		completedSteps += 1;
		host.reportSyncProgress?.({
			phase,
			completed: completedSteps,
			total: totalSteps,
		});
	};
	const localPaths = new Set<string>();
	const now = Date.now();
	for (const localFile of localFiles) {
		const path = normalizePath(localFile.path);
		localPaths.add(path);
		const localUpdatedAtMs = localFile.updatedAtMs;
		const remote = remoteByPath.get(path);
		if (!remote) {
			const bytes = await localFile.readBytes();
			await uploadBytesAtPath(
				host.settings,
				client,
				secret,
				clientId,
				path,
				bytes,
				localUpdatedAtMs,
			);
				tick("Uploading local files");
			continue;
		}
		const remoteComparableUpdatedAtMs = Math.min(remote.updatedAtMs, now);
		const isWithinSkewTolerance =
			Math.abs(localUpdatedAtMs - remoteComparableUpdatedAtMs) <=
			RECONCILE_CLOCK_SKEW_TOLERANCE_MS;
		if (!isWithinSkewTolerance && localUpdatedAtMs > remoteComparableUpdatedAtMs) {
			const bytes = await localFile.readBytes();
			const result = await uploadBytesAtPath(
				host.settings,
				client,
				secret,
				clientId,
				path,
				bytes,
				localUpdatedAtMs,
			);
			if (result === "stale_write") {
				await applyRemoteVaultPath(host, path);
			}
			tick("Reconciling newer local files");
			continue;
		}
		if (!isWithinSkewTolerance && remoteComparableUpdatedAtMs > localUpdatedAtMs) {
			await applyRemoteVaultPath(host, path);
			tick("Pulling newer remote files");
			continue;
		}
		const localBytes = await localFile.readBytes();
		const localHash = await sha256Bytes(localBytes);
		if (localHash === remote.contentHash) {
			tick("Checking unchanged files");
			continue;
		}
		const localWins = clientId.localeCompare(remote.updatedByClientId) <= 0;
		if (localWins) {
			await uploadBytesAtPath(
				host.settings,
				client,
				secret,
				clientId,
				path,
				localBytes,
				localUpdatedAtMs,
			);
		} else {
			await applyRemoteVaultPath(host, path);
		}
		tick("Resolving equal-timestamp conflicts");
	}

	for (const remoteFile of remoteFiles) {
		if (localPaths.has(remoteFile.path)) {
			tick("Skipping existing remote files");
			continue;
		}
		await applyRemoteVaultPath(host, remoteFile.path);
		tick("Creating missing local files");
	}

	await client.mutation(api.fileSync.syncFolderState, {
		convexSecret: secret,
		scannedAtMs: Date.now(),
		clientId,
		emptyFolderPaths: localState.emptyFolders,
	});
	tick("Syncing folder state");

	new Notice("Convex sync: vault files synchronized.", 5000);
}
