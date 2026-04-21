import { ConvexHttpClient } from "convex/browser";
import { unzipSync, zipSync } from "fflate";
import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import { api } from "../convex/_generated/api";
import type { MyPluginSettings } from "./settings";

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
	}>;
	folders: Array<{
		path: string;
		updatedAtMs: number;
		isExplicitlyEmpty: boolean;
		updatedByClientId: string;
	}>;
	obsidianBundle: {
		contentHash: string;
		sizeBytes: number;
		updatedAtMs: number;
		updatedByClientId: string;
	} | null;
};

type LocalFileEntry = {
	path: string;
	updatedAtMs: number;
	readBytes: () => Promise<ArrayBuffer>;
	writeBytes: (bytes: ArrayBuffer) => Promise<void>;
	createBytes: (bytes: ArrayBuffer) => Promise<void>;
};

const ARG_CHUNK_SIZE = 500;
const OBSIDIAN_ROOT = ".obsidian";
const OBSIDIAN_BUNDLE_IGNORE_PREFIXES = [
	".obsidian/cache/",
	".obsidian/workspace-mobile.json",
];

function isObsidianPath(path: string): boolean {
	return path === OBSIDIAN_ROOT || path.startsWith(`${OBSIDIAN_ROOT}/`);
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

function shouldIgnoreObsidianPath(path: string): boolean {
	return OBSIDIAN_BUNDLE_IGNORE_PREFIXES.some(
		(prefix) => path === prefix || path.startsWith(prefix),
	);
}

async function readRemoteFileBytes(
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
	const response = await fetch(signed.url, { method: "GET", cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Failed downloading ${path}: HTTP ${response.status}`);
	}
	const bytes = await response.arrayBuffer();
	return { bytes, updatedAtMs: signed.updatedAtMs };
}

async function uploadLocalFile(
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
			"Content-Type": "text/markdown; charset=utf-8",
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
		if (
			entry.path === OBSIDIAN_ROOT ||
			entry.path.startsWith(`${OBSIDIAN_ROOT}/`)
		) {
			continue;
		}
		if (entry.children.length === 0) {
			empty.push(normalizePath(entry.path));
		}
	}
	return empty;
}

async function collectDotObsidianState(app: App): Promise<{
	files: Array<{ path: string; updatedAtMs: number }>;
	emptyFolders: string[];
	maxUpdatedAtMs: number;
}> {
	const rootExists = await app.vault.adapter.exists(OBSIDIAN_ROOT);
	if (!rootExists) {
		return { files: [], emptyFolders: [], maxUpdatedAtMs: 0 };
	}
	const files: Array<{ path: string; updatedAtMs: number }> = [];
	const emptyFolders: string[] = [];
	let maxUpdatedAtMs = 0;
	const queue: string[] = [OBSIDIAN_ROOT];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}
		if (shouldIgnoreObsidianPath(current)) {
			continue;
		}
		const listed = await app.vault.adapter.list(current);
		if (listed.files.length === 0 && listed.folders.length === 0) {
			emptyFolders.push(normalizePath(current));
		}
		for (const filePath of listed.files) {
			if (shouldIgnoreObsidianPath(filePath)) {
				continue;
			}
			const stat = await app.vault.adapter.stat(filePath);
			if (!stat || stat.type !== "file") {
				continue;
			}
			if (stat.mtime > maxUpdatedAtMs) {
				maxUpdatedAtMs = stat.mtime;
			}
			files.push({
				path: normalizePath(filePath),
				updatedAtMs: stat.mtime,
			});
		}
		for (const folderPath of listed.folders) {
			queue.push(normalizePath(folderPath));
		}
	}
	return { files, emptyFolders, maxUpdatedAtMs };
}

async function listLocalEntries(host: FileSyncHost): Promise<{
	files: LocalFileEntry[];
	emptyFolders: string[];
}> {
	const fromVault = host.app.vault
		.getAllLoadedFiles()
		.filter((entry): entry is TFile => entry instanceof TFile)
		.filter(
			(file) =>
				file.path !== OBSIDIAN_ROOT &&
				!file.path.startsWith(`${OBSIDIAN_ROOT}/`),
		)
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

	return {
		files: [...byPath.values()],
		emptyFolders: listEmptyFolders(host.app),
	};
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

async function buildObsidianBundle(app: App): Promise<{
	zipBytes: ArrayBuffer | null;
	updatedAtMs: number;
}> {
	const state = await collectDotObsidianState(app);
	if (state.files.length === 0) {
		return { zipBytes: null, updatedAtMs: 0 };
	}
	const archiveEntries: Record<string, Uint8Array> = {};
	for (const file of state.files) {
		const relPath = file.path.slice(`${OBSIDIAN_ROOT}/`.length);
		if (!relPath) {
			continue;
		}
		const raw = await app.vault.adapter.readBinary(file.path);
		archiveEntries[relPath] = new Uint8Array(raw);
	}
	const zipped = zipSync(archiveEntries, { level: 6 });
	return { zipBytes: toArrayBuffer(zipped), updatedAtMs: state.maxUpdatedAtMs };
}

async function readRemoteObsidianBundle(
	client: ConvexHttpClient,
	secret: string,
): Promise<{ bytes: ArrayBuffer; updatedAtMs: number } | null> {
	const signed = await client.query(api.fileSync.getBundleDownloadUrl, {
		convexSecret: secret,
	});
	if (!signed) {
		return null;
	}
	const response = await fetch(signed.url, { method: "GET", cache: "no-store" });
	if (!response.ok) {
		throw new Error(
			`Failed downloading ${OBSIDIAN_ROOT} bundle: HTTP ${response.status}`,
		);
	}
	return { bytes: await response.arrayBuffer(), updatedAtMs: signed.updatedAtMs };
}

async function uploadObsidianBundle(
	client: ConvexHttpClient,
	secret: string,
	clientId: string,
	zipBytes: ArrayBuffer,
	updatedAtMs: number,
): Promise<"ok" | "stale_write"> {
	const blob = new Blob([zipBytes], { type: "application/zip" });
	const contentHash = await sha256Bytes(zipBytes);
	const issued = await client.mutation(api.fileSync.issueBundleUploadUrl, {
		convexSecret: secret,
		contentHash,
		updatedAtMs,
		sizeBytes: blob.size,
		clientId,
	});
	const uploadResponse = await fetch(issued.uploadUrl, {
		method: "POST",
		headers: { "Content-Type": "application/zip" },
		body: blob,
	});
	if (!uploadResponse.ok) {
		throw new Error(
			`Upload failed for ${OBSIDIAN_ROOT} bundle: HTTP ${uploadResponse.status}`,
		);
	}
	const payload = (await uploadResponse.json()) as { storageId?: string };
	if (!payload.storageId) {
		throw new Error("Upload did not return storageId for .obsidian bundle");
	}
	const finalized = await client.mutation(api.fileSync.finalizeBundleUpload, {
		convexSecret: secret,
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

async function applyObsidianBundle(app: App, zipBytes: ArrayBuffer): Promise<void> {
	await ensureAdapterFolderExists(app, OBSIDIAN_ROOT);
	const archive = unzipSync(new Uint8Array(zipBytes));
	const archivePaths = new Set<string>();
	for (const [relativePath, content] of Object.entries(archive)) {
		const cleanRelative = normalizePath(relativePath);
		const fullPath = normalizePath(`${OBSIDIAN_ROOT}/${cleanRelative}`);
		if (shouldIgnoreObsidianPath(fullPath)) {
			continue;
		}
		archivePaths.add(fullPath);
		const parent = folderPathForFile(fullPath);
		if (parent) {
			await ensureAdapterFolderExists(app, parent);
		}
		await app.vault.adapter.writeBinary(fullPath, toArrayBuffer(content));
	}
	const existing = await collectDotObsidianState(app);
	const staleFiles = existing.files
		.map((f) => f.path)
		.filter((path) => !archivePaths.has(path));
	for (const filePath of staleFiles) {
		await app.vault.adapter.remove(filePath);
	}
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
	const snapshot = (await client.query(api.fileSync.listSnapshot, {
		convexSecret: secret,
	})) as Snapshot;
	const remoteByPath = new Map(
		snapshot.files
			.filter((row) => !isObsidianPath(row.path))
			.map((row) => [row.path, row]),
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
	const remoteNonObsidianCount = snapshot.files.filter(
		(file) => !isObsidianPath(file.path),
	).length;
	const totalSteps = localFiles.length + remoteNonObsidianCount + 3;
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
	for (const localFile of localFiles) {
		const path = normalizePath(localFile.path);
		localPaths.add(path);
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
		if (isObsidianPath(remoteFile.path)) {
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

	const localBundle = await buildObsidianBundle(host.app);
	const remoteBundle = snapshot.obsidianBundle;
	if (localBundle.zipBytes && !remoteBundle) {
		await uploadObsidianBundle(
			client,
			secret,
			clientId,
			localBundle.zipBytes,
			localBundle.updatedAtMs,
		);
	} else if (localBundle.zipBytes && remoteBundle) {
		if (localBundle.updatedAtMs > remoteBundle.updatedAtMs) {
			const result = await uploadObsidianBundle(
				client,
				secret,
				clientId,
				localBundle.zipBytes,
				localBundle.updatedAtMs,
			);
			if (result === "stale_write") {
				const remote = await readRemoteObsidianBundle(client, secret);
				if (remote) {
					await applyObsidianBundle(host.app, remote.bytes);
				}
			}
		} else if (remoteBundle.updatedAtMs > localBundle.updatedAtMs) {
			const remote = await readRemoteObsidianBundle(client, secret);
			if (remote) {
				await applyObsidianBundle(host.app, remote.bytes);
			}
		} else {
			const localHash = await sha256Bytes(localBundle.zipBytes);
			if (localHash !== remoteBundle.contentHash) {
				const localWins =
					clientId.localeCompare(remoteBundle.updatedByClientId) <= 0;
				if (localWins) {
					await uploadObsidianBundle(
						client,
						secret,
						clientId,
						localBundle.zipBytes,
						localBundle.updatedAtMs,
					);
				} else {
					const remote = await readRemoteObsidianBundle(client, secret);
					if (remote) {
						await applyObsidianBundle(host.app, remote.bytes);
					}
				}
			}
		}
	} else if (!localBundle.zipBytes && remoteBundle) {
		const remote = await readRemoteObsidianBundle(client, secret);
		if (remote) {
			await applyObsidianBundle(host.app, remote.bytes);
		}
	}
	tick("Syncing .obsidian bundle");

	await client.mutation(api.fileSync.syncFolderState, {
		convexSecret: secret,
		scannedAtMs: Date.now(),
		clientId,
		emptyFolderPaths: localState.emptyFolders,
	});
	tick("Syncing folder state");

	const removedRemotePaths = snapshot.files
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
