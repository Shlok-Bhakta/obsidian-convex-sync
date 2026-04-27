import { ConvexHttpClient } from "convex/browser";
import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import { api } from "../convex/_generated/api";
import type { MyPluginSettings } from "./settings";
import { withSuppressedLocalChange } from "./sync/local-change-suppressor";
import {
	pushTextDocumentSnapshot,
	readRemoteTextContent,
} from "./sync/text-sync-transport";
import { createTextYDoc, sha256Utf8, textByteLength } from "./sync/text-sync-shared";

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

/** Optional client-side pacing (see `MyPluginSettings.relaxBinarySyncBandwidthPacing`). */
export type BinaryVaultTransferOptions = {
	relaxBandwidthPacing?: boolean;
};

export function binaryTransferOpts(settings: MyPluginSettings): BinaryVaultTransferOptions {
	return settings.relaxBinarySyncBandwidthPacing ? { relaxBandwidthPacing: true } : {};
}

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
		updatedByClientId?: string;
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConvexWriteBandwidthError(message: string): boolean {
	return (
		message.includes("Too many writes per second") ||
		message.includes("bytes written per 1 second")
	);
}

/**
 * Convex Cloud limits binary write throughput per deployment; spacing finalizes avoids bursts
 * after large uploads (patch + old blob delete count toward the limit). Self-hosted backends
 * can disable this via settings (`relaxBinarySyncBandwidthPacing`).
 */
async function paceAfterBinaryFinalize(sizeBytes: number, relaxPacing: boolean): Promise<void> {
	if (relaxPacing) return;
	const msPerMb = 400;
	const mb = sizeBytes / (1024 * 1024);
	const waitMs = Math.min(5000, Math.max(90, Math.ceil(mb * msPerMb)));
	await sleep(waitMs);
}

const REMOTE_DOWNLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

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
	await withSuppressedLocalChange(normalized, async () => {
		await app.vault.createFolder(normalized);
	});
}

async function writeLocalTextFile(app: App, path: string, content: string): Promise<void> {
	const normalized = normalizePath(path);
	const parent = folderPathForFile(normalized);
	if (parent) {
		await ensureFolderExists(app, parent);
	}
	const existing = app.vault.getAbstractFileByPath(normalized);
	await withSuppressedLocalChange(normalized, async () => {
		if (existing instanceof TFile) {
			await app.vault.modify(existing, content);
			return;
		}
		if (await app.vault.adapter.exists(normalized)) {
			await app.vault.adapter.write(normalized, content);
			return;
		}
		await app.vault.create(normalized, content);
	});
}

export async function readRemoteFileBytes(
	client: ConvexHttpClient,
	secret: string,
	path: string,
	options?: BinaryVaultTransferOptions,
): Promise<{ bytes: ArrayBuffer; updatedAtMs: number } | null> {
	const relax = options?.relaxBandwidthPacing === true;
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
		let offset = 0;
		let totalSize = 0;
		let updatedAtMs = 0;
		const chunks: Uint8Array[] = [];
		for (;;) {
			const part = await client.action(api.fileSync.getFileBytesChunk, {
				convexSecret: secret,
				path,
				byteOffset: offset,
				maxBytes: REMOTE_DOWNLOAD_CHUNK_BYTES,
			});
			if (!part) {
				if (chunks.length === 0) {
					return null;
				}
				throw new Error(`getFileBytesChunk returned null mid-stream for ${path}`);
			}
			totalSize = part.sizeBytes;
			updatedAtMs = part.updatedAtMs;
			chunks.push(new Uint8Array(part.bytes));
			if (part.isLast) {
				break;
			}
			offset += part.bytes.byteLength;
			if (offset >= totalSize) {
				break;
			}
			// Tiny delay so chunk reads do not stampede Convex if many files fail HTTPS at once.
			if (!relax) {
				await sleep(20);
			}
		}
		const out = new Uint8Array(totalSize);
		let writeAt = 0;
		for (const c of chunks) {
			out.set(c, writeAt);
			writeAt += c.byteLength;
		}
		return { bytes: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength), updatedAtMs };
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
	options?: BinaryVaultTransferOptions,
): Promise<"ok" | "stale_write"> {
	const relax = options?.relaxBandwidthPacing === true;
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
	const finalizeArgs = {
		convexSecret: secret,
		path,
		storageId: payload.storageId as never,
		contentHash,
		updatedAtMs,
		sizeBytes: blob.size,
		clientId,
	};
	let finalized: { ok: true } | { ok: false; reason: "stale_write"; remoteUpdatedAtMs: number };
	let attempt = 0;
	const maxFinalizeAttempts = 10;
	let backoffMs = 500;
	for (;;) {
		try {
			finalized = await client.mutation(api.fileSync.finalizeUpload, finalizeArgs);
			break;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!isConvexWriteBandwidthError(message) || attempt >= maxFinalizeAttempts - 1) {
				throw err;
			}
			attempt += 1;
			await sleep(backoffMs);
			backoffMs = Math.min(backoffMs * 2, 10_000);
		}
	}
	await paceAfterBinaryFinalize(blob.size, relax);
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
	const xfer = binaryTransferOpts(host.settings);
	host.reportSyncProgress?.({
		phase: "Preparing snapshot",
		completed: 0,
		total: 1,
	});
	const snapshot = await fetchSnapshot(client, secret);
	const remoteBinaryByPath = new Map(
		snapshot.files.filter((row) => !row.isText).map((row) => [row.path, row]),
	);
	const remoteTextByPath = new Map(
		snapshot.files.filter((row) => row.isText).map((row) => [row.path, row]),
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
	const localTextFiles = localFiles.filter((file) => isTextSyncFile(normalizePath(file.path)));
	const remoteBinaryCount = snapshot.files.filter((file) => !file.isText).length;
	const remoteTextCount = snapshot.files.filter((file) => file.isText).length;
	const localBinaryCount = localFiles.filter(
		(f) => !isTextSyncFile(normalizePath(f.path)),
	).length;
	const totalSteps = localBinaryCount + remoteBinaryCount + localTextFiles.length + remoteTextCount + 1;
	let completedSteps = 0;
	const tick = (phase: string): void => {
		completedSteps += 1;
		host.reportSyncProgress?.({
			phase,
			completed: completedSteps,
			total: totalSteps,
		});
	};
	for (const localFile of localTextFiles) {
		const path = normalizePath(localFile.path);
		const abstract = host.app.vault.getAbstractFileByPath(path);
		if (!(abstract instanceof TFile)) {
			tick("Skipping unavailable local notes");
			continue;
		}
		const localContent = await host.app.vault.cachedRead(abstract);
		const localHash = await sha256Utf8(localContent);
		const remote = remoteTextByPath.get(path);
		if (!remote) {
			const doc = createTextYDoc(localContent);
			try {
				await pushTextDocumentSnapshot({
					client,
					convexApi: api,
					convexSecret: secret,
					clientId,
					vaultName: host.app.vault.getName(),
					path,
					doc,
					updatedAtMs: abstract.stat.mtime,
				});
			} finally {
				doc.destroy();
			}
			tick("Uploading local notes");
			continue;
		}
		if (remote.updatedAtMs > abstract.stat.mtime) {
			const remoteContent = await readRemoteTextContent({
				client,
				convexApi: api,
				convexSecret: secret,
				vaultName: host.app.vault.getName(),
				path,
			});
			await writeLocalTextFile(host.app, path, remoteContent);
			tick("Pulling newer remote notes");
			continue;
		}
		if (abstract.stat.mtime > remote.updatedAtMs) {
			const doc = createTextYDoc(localContent);
			try {
				await pushTextDocumentSnapshot({
					client,
					convexApi: api,
					convexSecret: secret,
					clientId,
					vaultName: host.app.vault.getName(),
					path,
					doc,
					updatedAtMs: abstract.stat.mtime,
				});
			} finally {
				doc.destroy();
			}
			tick("Reconciling newer local notes");
			continue;
		}
		if (localHash === remote.contentHash) {
			tick("Checking unchanged notes");
			continue;
		}
		const localWins = clientId.localeCompare(remote.updatedByClientId) <= 0;
		if (localWins) {
			const doc = createTextYDoc(localContent);
			try {
				await pushTextDocumentSnapshot({
					client,
					convexApi: api,
					convexSecret: secret,
					clientId,
					vaultName: host.app.vault.getName(),
					path,
					doc,
					updatedAtMs: abstract.stat.mtime,
				});
			} finally {
				doc.destroy();
			}
		} else {
			const remoteContent = await readRemoteTextContent({
				client,
				convexApi: api,
				convexSecret: secret,
				vaultName: host.app.vault.getName(),
				path,
			});
			await writeLocalTextFile(host.app, path, remoteContent);
		}
		tick("Resolving note conflicts");
	}

	for (const localFile of localFiles) {
		const path = normalizePath(localFile.path);
		if (isTextSyncFile(path)) {
			continue;
		}
		const localUpdatedAtMs = localFile.updatedAtMs;
		const remote = remoteBinaryByPath.get(path);
		if (!remote) {
			const bytes = await localFile.readBytes();
			await uploadLocalFile(
				client,
				secret,
				clientId,
				path,
				bytes,
				localUpdatedAtMs,
				xfer,
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
				xfer,
			);
			if (result === "stale_write") {
				const remotePayload = await readRemoteFileBytes(client, secret, path, xfer);
				if (remotePayload) {
					await localFile.writeBytes(remotePayload.bytes);
				}
			}
			tick("Reconciling newer local files");
			continue;
		}
		if (remote.updatedAtMs > localUpdatedAtMs) {
			const remotePayload = await readRemoteFileBytes(client, secret, path, xfer);
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
				xfer,
			);
		} else {
			const remotePayload = await readRemoteFileBytes(client, secret, path, xfer);
			if (remotePayload) {
				await localFile.writeBytes(remotePayload.bytes);
			}
		}
		tick("Resolving equal-timestamp conflicts");
	}

	for (const remoteFile of snapshot.files) {
		if (remoteFile.isText) {
			if (localPaths.has(remoteFile.path)) {
				tick("Skipping existing remote notes");
				continue;
			}
			const remoteContent = await readRemoteTextContent({
				client,
				convexApi: api,
				convexSecret: secret,
				vaultName: host.app.vault.getName(),
				path: remoteFile.path,
			});
			await writeLocalTextFile(host.app, remoteFile.path, remoteContent);
			tick("Creating missing local notes");
			continue;
		}
		if (localPaths.has(remoteFile.path)) {
			tick("Skipping existing remote files");
			continue;
		}
		const remotePayload = await readRemoteFileBytes(client, secret, remoteFile.path, xfer);
		if (!remotePayload) {
			tick("Skipping unavailable remote files");
			continue;
		}
		const parent = folderPathForFile(remoteFile.path);
		if (parent) {
			await ensureFolderExists(host.app, parent);
		}
		await withSuppressedLocalChange(remoteFile.path, async () => {
			await host.app.vault.createBinary(remoteFile.path, remotePayload.bytes);
		});
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
