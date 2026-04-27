import { ConvexHttpClient } from "convex/browser";
import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import { api } from "../convex/_generated/api";
import type { MyPluginSettings } from "./settings";

// INTENTIONAL: Only .md files use Yjs. Other text-like files (.json, .canvas, .svg, etc.)
// sync as binary blobs — no CRDT merge semantics required unless we extend this later.
export function isTextSyncFile(path: string): boolean {
	return path.endsWith(".md");
}

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
		sizeBytes: number;
		updatedAtMs: number;
		updatedByClientId: string;
		isText: boolean;
		storageId?: string;
	}>;
	folders: Array<{
		path: string;
		updatedAtMs: number;
		isExplicitlyEmpty: boolean;
		updatedByClientId: string;
	}>;
};

const SNAPSHOT_PAGE_SIZE = 200;

type LocalFileEntry = {
	path: string;
	updatedAtMs: number;
	readBytes: () => Promise<ArrayBuffer>;
	writeBytes: (bytes: ArrayBuffer) => Promise<void>;
	createBytes: (bytes: ArrayBuffer) => Promise<void>;
};

const ARG_CHUNK_SIZE = 500;

type SnapshotPage<T> = {
	page: T[];
	isDone: boolean;
	continueCursor: string;
};

async function fetchSnapshot(client: ConvexHttpClient, secret: string): Promise<Snapshot> {
	const files: Snapshot["files"] = [];
	const folders: Snapshot["folders"] = [];
	let fileCursor: string | null = null;
	let folderCursor: string | null = null;
	let filesDone = false;
	let foldersDone = false;

	while (!filesDone) {
		const page = (await client.query(api.fileSync.listBinarySnapshotPage, {
			convexSecret: secret,
			paginationOpts: { cursor: fileCursor, numItems: SNAPSHOT_PAGE_SIZE },
		})) as SnapshotPage<Snapshot["files"][number]>;
		files.push(...page.page);
		filesDone = page.isDone;
		fileCursor = page.continueCursor;
	}

	while (!foldersDone) {
		const page = (await client.query(api.fileSync.listFolderSnapshotPage, {
			convexSecret: secret,
			paginationOpts: { cursor: folderCursor, numItems: SNAPSHOT_PAGE_SIZE },
		})) as SnapshotPage<Snapshot["folders"][number]>;
		folders.push(...page.page);
		foldersDone = page.isDone;
		folderCursor = page.continueCursor;
	}

	return { files, folders };
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

async function ensureFolderExists(app: App, path: string): Promise<void> {
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
		await ensureFolderExists(app, parent);
	}
	await app.vault.createFolder(normalized);
}

export async function readRemoteFileBytes(
	client: ConvexHttpClient,
	secret: string,
	path: string,
): Promise<{ bytes: ArrayBuffer; updatedAtMs: number } | null> {
	const signed = await client.query(api.fileSync.getDownloadUrl, {
		convexSecret: secret,
		path,
	});
	if (!signed) {
		return null;
	}
	try {
		const response = await fetch(signed.url, {
			method: "GET",
			cache: "no-store",
		});
		if (!response.ok) {
			throw new Error(`Failed downloading ${path}: HTTP ${response.status}`);
		}
		const bytes = await response.arrayBuffer();
		return { bytes, updatedAtMs: signed.updatedAtMs };
	} catch (error) {
		console.warn("[file-sync] signed download failed, falling back to Convex action", {
			path,
			message: error instanceof Error ? error.message : String(error),
		});
		const fallback = await client.action(api.fileSync.getFileBytes, {
			convexSecret: secret,
			path,
		});
		if (!fallback) {
			return null;
		}
		return { bytes: fallback.bytes, updatedAtMs: fallback.updatedAtMs };
	}
}

/** Upload or replace a binary vault file (used by manual sync and realtime binary sync). */
export async function uploadLocalFile(
	client: ConvexHttpClient,
	secret: string,
	clientId: string,
	path: string,
	bytes: ArrayBuffer,
	updatedAtMs: number,
): Promise<"ok" | "stale_write"> {
	const blob = new Blob([bytes], { type: "application/octet-stream" });
	const contentHash = await sha256Bytes(bytes);
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
		updatedAtMs,
		sizeBytes: blob.size,
		clientId,
	});
	if (!finalized.ok && finalized.reason === "stale_write") {
		return "stale_write";
	}
	return "ok";
}

function listEmptyFolders(app: App): string[] {
	const all = app.vault.getAllLoadedFiles();
	const empty: string[] = [];
	for (const entry of all) {
		if (!(entry instanceof TFolder)) {
			continue;
		}
		if (entry.path.trim() === "") {
			continue;
		}
		if (entry.children.length === 0) {
			empty.push(normalizePath(entry.path));
		}
	}
	return empty;
}

/**
 * Join a parent vault path and a child name from `adapter.list`.
 * Some adapters return names relative to the vault root (e.g. `.obsidian/plugins`)
 * instead of a single segment (`plugins`); naive joining would duplicate segments.
 */
function vaultChildPath(parentDir: string, childName: string): string {
	const parent = normalizePath(parentDir);
	const raw = childName.replace(/\\/g, "/").trim();
	const childNorm = normalizePath(raw);

	if (!parent) {
		return childNorm;
	}
	if (childNorm === parent) {
		return parent;
	}
	if (childNorm.startsWith(`${parent}/`)) {
		return childNorm;
	}
	return normalizePath(`${parent}/${raw}`);
}

/**
 * Obsidian does not put the config folder (usually `.obsidian`) in `getAllLoadedFiles()`.
 * Walk it on the adapter so "Sync vault files" includes plugins, themes, app.json, etc.
 */
async function collectConfigDirSyncState(
	app: App,
	configDir: string,
): Promise<{ files: LocalFileEntry[]; emptyFolders: string[] }> {
	const root = normalizePath(configDir);
	const files: LocalFileEntry[] = [];
	const emptyFolders: string[] = [];

	if (!root || !(await app.vault.adapter.exists(root))) {
		return { files, emptyFolders };
	}

	async function visitDir(dirPath: string): Promise<void> {
		let listed: Awaited<ReturnType<typeof app.vault.adapter.list>>;
		try {
			listed = await app.vault.adapter.list(dirPath);
		} catch {
			// ENOENT if list() returns stale names or paths are inconsistent; do not fail vault sync.
			return;
		}
		if (listed.files.length === 0 && listed.folders.length === 0) {
			emptyFolders.push(normalizePath(dirPath));
			return;
		}
		for (const name of listed.files) {
			const path = vaultChildPath(dirPath, name);
			const st = await app.vault.adapter.stat(path);
			if (!st || st.type !== "file") {
				continue;
			}
			files.push({
				path,
				updatedAtMs: st.mtime,
				readBytes: () => app.vault.adapter.readBinary(path),
				writeBytes: (bytes) => app.vault.adapter.writeBinary(path, bytes),
				createBytes: (bytes) => app.vault.createBinary(path, bytes).then(() => {}),
			});
		}
		for (const name of listed.folders) {
			await visitDir(vaultChildPath(dirPath, name));
		}
	}

	await visitDir(root);
	return { files, emptyFolders };
}

async function listLocalEntries(host: FileSyncHost): Promise<{
	files: LocalFileEntry[];
	emptyFolders: string[];
}> {
	const fromVault = host.app.vault
		.getAllLoadedFiles()
		.filter((entry): entry is TFile => entry instanceof TFile)
		.map<LocalFileEntry>((file) => ({
			path: normalizePath(file.path),
			updatedAtMs: file.stat.mtime,
			readBytes: () => host.app.vault.readBinary(file),
			writeBytes: (bytes) => host.app.vault.modifyBinary(file, bytes),
			createBytes: (bytes) => host.app.vault.createBinary(file.path, bytes).then(() => {}),
		}));

	const byPath = new Map<string, LocalFileEntry>();
	for (const entry of fromVault) {
		byPath.set(entry.path, entry);
	}

	const configState = await collectConfigDirSyncState(host.app, host.app.vault.configDir);
	for (const entry of configState.files) {
		if (!byPath.has(entry.path)) {
			byPath.set(entry.path, entry);
		}
	}

	const emptyFolders = new Set(listEmptyFolders(host.app));
	for (const p of configState.emptyFolders) {
		emptyFolders.add(p);
	}

	return {
		files: [...byPath.values()],
		emptyFolders: [...emptyFolders],
	};
}

export async function runVaultFileSync(host: FileSyncHost): Promise<void> {
	const url = host.settings.convexUrl.trim();
	const secret = host.settings.convexSecret.trim();
	if (!url || !secret) {
		new Notice("Convex sync: set Convex URL and secret first.", 8000);
		return;
	}

	const client = host.getConvexHttpClient();
	const clientId = host.getPresenceSessionId();
	host.reportSyncProgress?.({
		phase: "Preparing snapshot",
		completed: 0,
		total: 1,
	});
	const snapshot = await fetchSnapshot(client, secret);
	const remoteByPath = new Map(
		snapshot.files.filter((row) => !row.isText).map((row) => [row.path, row]),
	);
	for (const remoteFolder of snapshot.folders) {
		if (!remoteFolder.isExplicitlyEmpty) {
			continue;
		}
		const existing = host.app.vault.getAbstractFileByPath(remoteFolder.path);
		if (!existing) {
			await ensureFolderExists(host.app, remoteFolder.path);
		}
	}

	const localState = await listLocalEntries(host);
	const localFiles = localState.files;
	const localPaths = new Set(
		localFiles.map((f) => normalizePath(f.path)),
	);
	const remoteBinaryCount = snapshot.files.filter((file) => !file.isText).length;
	const localBinaryCount = localFiles.filter(
		(f) => !isTextSyncFile(normalizePath(f.path)),
	).length;
	const totalSteps = localBinaryCount + remoteBinaryCount + 2;
	let completedSteps = 0;
	const tick = (phase: string): void => {
		completedSteps += 1;
		host.reportSyncProgress?.({
			phase,
			completed: completedSteps,
			total: totalSteps,
		});
	};
	for (const localFile of localFiles) {
		const path = normalizePath(localFile.path);
		if (isTextSyncFile(path)) {
			continue;
		}
		const localUpdatedAtMs = localFile.updatedAtMs;
		const remote = remoteByPath.get(path);
		if (!remote) {
			const bytes = await localFile.readBytes();
			await uploadLocalFile(
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
		if (localUpdatedAtMs > remote.updatedAtMs) {
			const bytes = await localFile.readBytes();
			const result = await uploadLocalFile(
				client,
				secret,
				clientId,
				path,
				bytes,
				localUpdatedAtMs,
			);
			if (result === "stale_write") {
				const remotePayload = await readRemoteFileBytes(client, secret, path);
				if (remotePayload) {
					await localFile.writeBytes(remotePayload.bytes);
				}
			}
			tick("Reconciling newer local files");
			continue;
		}
		if (remote.updatedAtMs > localUpdatedAtMs) {
			const remotePayload = await readRemoteFileBytes(client, secret, path);
			if (!remotePayload) {
				tick("Skipping unavailable remote updates");
				continue;
			}
			await localFile.writeBytes(remotePayload.bytes);
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
			await uploadLocalFile(
				client,
				secret,
				clientId,
				path,
				localBytes,
				localUpdatedAtMs,
			);
		} else {
			const remotePayload = await readRemoteFileBytes(client, secret, path);
			if (remotePayload) {
				await localFile.writeBytes(remotePayload.bytes);
			}
		}
		tick("Resolving equal-timestamp conflicts");
	}

	for (const remoteFile of snapshot.files) {
		if (remoteFile.isText) {
			continue;
		}
		if (localPaths.has(remoteFile.path)) {
			tick("Skipping existing remote files");
			continue;
		}
		const remotePayload = await readRemoteFileBytes(
			client,
			secret,
			remoteFile.path,
		);
		if (!remotePayload) {
			tick("Skipping unavailable remote files");
			continue;
		}
		const parent = folderPathForFile(remoteFile.path);
		if (parent) {
			await ensureFolderExists(host.app, parent);
		}
		await host.app.vault.createBinary(remoteFile.path, remotePayload.bytes);
		tick("Creating missing local files");
	}

	await client.mutation(api.fileSync.syncFolderState, {
		convexSecret: secret,
		scannedAtMs: Date.now(),
		clientId,
		emptyFolderPaths: localState.emptyFolders,
	});
	tick("Syncing folder state");

	const removedRemotePaths = snapshot.files
		.filter((file) => !file.isText)
		.map((file) => file.path)
		.filter((path) => !localPaths.has(path));
	for (let i = 0; i < removedRemotePaths.length; i += ARG_CHUNK_SIZE) {
		const chunk = removedRemotePaths.slice(i, i + ARG_CHUNK_SIZE);
		await client.mutation(api.fileSync.removeFilesByPath, {
			convexSecret: secret,
			removedPaths: chunk,
		});
	}
	tick("Pruning remote deletions");

	new Notice("Convex sync: vault files synchronized.", 5000);
}
