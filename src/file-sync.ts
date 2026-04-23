import { ConvexHttpClient } from "convex/browser";
import { Notice, TFile, TFolder, normalizePath } from "obsidian";
import { api } from "../convex/_generated/api";
import {
	collectTrackedObsidianState,
	ensureAdapterFolderExists,
	folderPathForFile,
	isObsidianPath,
	OBSIDIAN_ROOT,
	shouldTrackObsidianPath,
} from "./obsidian-config";
import type { MyPluginSettings } from "./settings";
import { matchesSyncIgnorePath } from "./sync-ignore";

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
};

type LocalFileEntry = {
	path: string;
	updatedAtMs: number;
	readBytes: () => Promise<ArrayBuffer>;
	writeBytes: (bytes: ArrayBuffer) => Promise<void>;
	createBytes: (bytes: ArrayBuffer) => Promise<void>;
};

const ARG_CHUNK_SIZE = 500;

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

function listEmptyFolders(app: App, ignorePaths: string[]): string[] {
	const all = app.vault.getAllLoadedFiles();
	const empty: string[] = [];
	for (const entry of all) {
		if (!(entry instanceof TFolder)) {
			continue;
		}
		if (entry.path.trim() === "") {
			continue;
		}
		if (matchesSyncIgnorePath(entry.path, ignorePaths)) {
			continue;
		}
		if (isObsidianPath(entry.path)) {
			continue;
		}
		if (entry.children.length === 0) {
			empty.push(normalizePath(entry.path));
		}
	}
	return empty;
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
				!file.path.startsWith(`${OBSIDIAN_ROOT}/`) &&
				!matchesSyncIgnorePath(file.path, host.settings.syncIgnorePaths),
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

	const trackedObsidian = await collectTrackedObsidianState(
		host.app,
		host.settings.syncIgnorePaths,
	);
	for (const file of trackedObsidian.files) {
		byPath.set(file.path, {
			path: file.path,
			updatedAtMs: file.updatedAtMs,
			readBytes: () => host.app.vault.adapter.readBinary(file.path),
			writeBytes: async (bytes) => {
				const parent = folderPathForFile(file.path);
				if (parent) {
					await ensureAdapterFolderExists(host.app, parent);
				}
				await host.app.vault.adapter.writeBinary(file.path, bytes);
			},
			createBytes: async (bytes) => {
				const parent = folderPathForFile(file.path);
				if (parent) {
					await ensureAdapterFolderExists(host.app, parent);
				}
				await host.app.vault.adapter.writeBinary(file.path, bytes);
			},
		});
	}

	return {
		files: [...byPath.values()],
		emptyFolders: [
			...listEmptyFolders(host.app, host.settings.syncIgnorePaths),
			...trackedObsidian.emptyFolders,
		],
	};
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
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
			.filter((row) => !matchesSyncIgnorePath(row.path, host.settings.syncIgnorePaths))
			.filter(
				(row) =>
					!isObsidianPath(row.path) ||
					shouldTrackObsidianPath(row.path, host.settings.syncIgnorePaths),
			)
			.map((row) => [row.path, row]),
	);
	for (const remoteFolder of snapshot.folders) {
		if (matchesSyncIgnorePath(remoteFolder.path, host.settings.syncIgnorePaths)) {
			continue;
		}
		if (
			isObsidianPath(remoteFolder.path) &&
			!shouldTrackObsidianPath(remoteFolder.path, host.settings.syncIgnorePaths)
		) {
			continue;
		}
		if (!remoteFolder.isExplicitlyEmpty) {
			continue;
		}
		if (isObsidianPath(remoteFolder.path)) {
			await ensureAdapterFolderExists(host.app, remoteFolder.path);
			continue;
		}
		const existing = host.app.vault.getAbstractFileByPath(remoteFolder.path);
		if (!existing) {
			await ensureFolderExists(host.app, remoteFolder.path);
		}
	}

	const localState = await listLocalEntries(host);
	const localFiles = localState.files;
	const trackedRemoteFiles = snapshot.files.filter(
		(file) =>
			!matchesSyncIgnorePath(file.path, host.settings.syncIgnorePaths) &&
			(!isObsidianPath(file.path) ||
				shouldTrackObsidianPath(file.path, host.settings.syncIgnorePaths)),
	).length;
	const totalSteps = localFiles.length + trackedRemoteFiles + 2;
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
			if ((await sha256Bytes(bytes)) === remote.contentHash) {
				tick("Checking unchanged files");
				continue;
			}
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
		if (matchesSyncIgnorePath(remoteFile.path, host.settings.syncIgnorePaths)) {
			continue;
		}
		if (
			isObsidianPath(remoteFile.path) &&
			!shouldTrackObsidianPath(remoteFile.path, host.settings.syncIgnorePaths)
		) {
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
		if (isObsidianPath(remoteFile.path)) {
			if (parent) {
				await ensureAdapterFolderExists(host.app, parent);
			}
			await host.app.vault.adapter.writeBinary(remoteFile.path, remotePayload.bytes);
		} else {
			if (parent) {
				await ensureFolderExists(host.app, parent);
			}
			await host.app.vault.createBinary(remoteFile.path, remotePayload.bytes);
		}
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
		.map((file) => file.path)
		.filter((path) => !matchesSyncIgnorePath(path, host.settings.syncIgnorePaths))
		.filter(
			(path) =>
				!isObsidianPath(path) ||
				shouldTrackObsidianPath(path, host.settings.syncIgnorePaths),
		)
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
