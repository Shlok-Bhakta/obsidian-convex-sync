import { Notice, normalizePath } from "obsidian";
import { api } from "../../convex/_generated/api";
import { ensureAdapterFolderExists } from "../lib/obsidian-vault";
import { folderPathForFile } from "../lib/path";
import { listDotObsidianEntries } from "./local-entries";
import {
	ARG_CHUNK_SIZE,
	isDotObsidianPath,
	OBSIDIAN_ROOT,
	shouldIgnoreVaultPath,
} from "./path-rules";
import {
	readRemoteFileBytes,
	sha256Bytes,
	uploadLocalFile,
} from "./remote-transfer";
import type { FileSyncHost, Snapshot } from "./types";

export type ConfigSyncResult = {
	filesUploaded: number;
	filesDownloaded: number;
	remoteFilesDeleted: number;
	localFilesDeleted: number;
	foldersSynced: number;
};

type ConfigSyncOptions = {
	showRestartNotice?: boolean;
};

const RESTART_NOTICE =
	"Convex sync: .obsidian changed. Restart Obsidian to reload plugins, snippets, and settings.";

export async function pushDotObsidianConfig(
	host: FileSyncHost,
	options: ConfigSyncOptions = {},
): Promise<ConfigSyncResult> {
	const { client, secret, clientId } = getConfigSyncSession(host);
	const [snapshot, localState] = await Promise.all([
		client.query(api.fileSync.listSnapshot, {
			convexSecret: secret,
		}) as Promise<Snapshot>,
		listDotObsidianEntries(host),
	]);
	const localFiles = localState.files.filter((file) =>
		isSyncedDotObsidianPath(file.path),
	);
	const localPaths = new Set<string>();
	let filesUploaded = 0;

	for (const localFile of localFiles) {
		const path = normalizePath(localFile.path);
		localPaths.add(path);
		await uploadLocalFile(
			client,
			secret,
			clientId,
			path,
			await localFile.readBytes(),
			Date.now(),
			{ force: true },
		);
		filesUploaded += 1;
	}

	const removedRemotePaths = snapshot.files
		.map((file) => normalizePath(file.path))
		.filter(isSyncedDotObsidianPath)
		.filter((path) => !localPaths.has(path));
	await removeRemotePaths(client, secret, removedRemotePaths);

	const folderPaths = localState.folders
		.map((path) => normalizePath(path))
		.filter(isSyncedDotObsidianPath);
	const emptyFolderPaths = localState.emptyFolders
		.map((path) => normalizePath(path))
		.filter(isSyncedDotObsidianPath);
	await client.mutation(api.fileSync.syncFolderStateForRoot, {
		convexSecret: secret,
		scannedAtMs: Date.now(),
		clientId,
		rootPath: OBSIDIAN_ROOT,
		folderPaths,
		emptyFolderPaths,
	});

	if (options.showRestartNotice ?? true) {
		new Notice("Convex sync: pushed .obsidian config to Convex.", 5000);
	}
	return {
		filesUploaded,
		filesDownloaded: 0,
		remoteFilesDeleted: removedRemotePaths.length,
		localFilesDeleted: 0,
		foldersSynced: folderPaths.length,
	};
}

export async function pullDotObsidianConfig(
	host: FileSyncHost,
	options: ConfigSyncOptions = {},
): Promise<ConfigSyncResult> {
	const { client, secret } = getConfigSyncSession(host);
	const snapshot = (await client.query(api.fileSync.listSnapshot, {
		convexSecret: secret,
	})) as Snapshot;
	const result = await applyDotObsidianSnapshot(host, snapshot);
	if (options.showRestartNotice ?? true) {
		new Notice(RESTART_NOTICE, 10000);
	}
	return result;
}

export async function applyDotObsidianSnapshot(
	host: Pick<FileSyncHost, "app" | "settings" | "getConvexHttpClient">,
	snapshot: Snapshot,
): Promise<ConfigSyncResult> {
	const client = host.getConvexHttpClient();
	const secret = host.settings.convexSecret.trim();
	if (!secret) {
		throw new Error("Set Convex secret first.");
	}
	const remoteFiles = snapshot.files
		.map((file) => ({ ...file, path: normalizePath(file.path) }))
		.filter((file) => isSyncedDotObsidianPath(file.path));
	const remotePaths = new Set(remoteFiles.map((file) => file.path));
	const remoteFolders = snapshot.folders
		.map((folder) => ({ ...folder, path: normalizePath(folder.path) }))
		.filter((folder) => isSyncedDotObsidianPath(folder.path));

	let foldersChanged = 0;
	for (const folder of remoteFolders) {
		const exists = await host.app.vault.adapter.exists(folder.path);
		await ensureAdapterFolderExists(host.app, folder.path);
		if (!exists) {
			foldersChanged += 1;
		}
	}

	let filesDownloaded = 0;
	for (const remoteFile of remoteFiles) {
		const payload = await readRemoteConfigFileBytes(
			client,
			secret,
			remoteFile.path,
		);
		if (!payload) {
			continue;
		}
		const existingHash = await readLocalFileHash(host, remoteFile.path);
		if (existingHash === remoteFile.contentHash) {
			continue;
		}
		await ensureAdapterFolderExists(host.app, folderPathForFile(remoteFile.path));
		await host.app.vault.adapter.writeBinary(remoteFile.path, payload.bytes);
		filesDownloaded += 1;
	}

	const localState = await listDotObsidianEntries(host as FileSyncHost);
	const localFilesToDelete = localState.files
		.map((file) => normalizePath(file.path))
		.filter(isSyncedDotObsidianPath)
		.filter((path) => !remotePaths.has(path));
	for (const path of localFilesToDelete) {
		await host.app.vault.adapter.remove(path);
	}

	foldersChanged += await removeMissingLocalFolders(
		host,
		remoteFolders.map((folder) => folder.path),
	);

	return {
		filesUploaded: 0,
		filesDownloaded,
		remoteFilesDeleted: 0,
		localFilesDeleted: localFilesToDelete.length,
		foldersSynced: foldersChanged,
	};
}

export function showConfigRestartNotice(): void {
	new Notice(RESTART_NOTICE, 10000);
}

function getConfigSyncSession(host: FileSyncHost): {
	client: ReturnType<FileSyncHost["getConvexHttpClient"]>;
	secret: string;
	clientId: string;
} {
	const url = host.settings.convexUrl.trim();
	const secret = host.settings.convexSecret.trim();
	if (!url || !secret) {
		throw new Error("Set Convex URL and secret first.");
	}
	const clientId = host.getPresenceSessionId();
	if (!clientId) {
		throw new Error("Client session is not ready.");
	}
	return {
		client: host.getConvexHttpClient(),
		secret,
		clientId,
	};
}

function isSyncedDotObsidianPath(path: string): boolean {
	return isDotObsidianPath(path) && !shouldIgnoreVaultPath(path);
}

async function removeRemotePaths(
	client: ReturnType<FileSyncHost["getConvexHttpClient"]>,
	secret: string,
	paths: string[],
): Promise<void> {
	for (let index = 0; index < paths.length; index += ARG_CHUNK_SIZE) {
		await client.mutation(api.fileSync.removeFilesByPath, {
			convexSecret: secret,
			removedPaths: paths.slice(index, index + ARG_CHUNK_SIZE),
		});
	}
}

async function removeMissingLocalFolders(
	host: Pick<FileSyncHost, "app">,
	remoteFolderPaths: string[],
): Promise<number> {
	const remoteFolders = new Set(remoteFolderPaths);
	const localState = await listDotObsidianEntries(host as FileSyncHost);
	const localFolders = localState.folders
		.map((path) => normalizePath(path))
		.filter(isSyncedDotObsidianPath)
		.sort((a, b) => b.length - a.length);
	let deletedFolders = 0;
	for (const path of localFolders) {
		if (remoteFolders.has(path)) {
			continue;
		}
		const listed = await host.app.vault.adapter.list(path).catch(() => null);
		if (!listed || listed.files.length > 0 || listed.folders.length > 0) {
			continue;
		}
		await host.app.vault.adapter.rmdir(path, false);
		deletedFolders += 1;
	}
	return deletedFolders;
}

async function readLocalFileHash(
	host: Pick<FileSyncHost, "app">,
	path: string,
): Promise<string | null> {
	const stat = await host.app.vault.adapter.stat(path);
	if (stat?.type !== "file") {
		return null;
	}
	return sha256Bytes(await host.app.vault.adapter.readBinary(path));
}

async function readRemoteConfigFileBytes(
	client: ReturnType<FileSyncHost["getConvexHttpClient"]>,
	secret: string,
	path: string,
): Promise<{ bytes: ArrayBuffer; updatedAtMs: number } | null> {
	try {
		return await readRemoteFileBytes(client, secret, path);
	} catch (error) {
		console.warn("[config-sync] signed storage download failed; using Convex action fallback", {
			path,
			message: error instanceof Error ? error.message : String(error),
		});
	}
	const payload = await client.action(api.fileSync.getFileBytes, {
		convexSecret: secret,
		path,
	});
	if (!payload) {
		return null;
	}
	return {
		bytes: payload.bytes,
		updatedAtMs: payload.updatedAtMs,
	};
}
