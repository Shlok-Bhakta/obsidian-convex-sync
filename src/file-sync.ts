import { Notice, normalizePath } from "obsidian";
import { api } from "../convex/_generated/api";
import {
	ensureAdapterFolderExists,
	ensureVaultFolderExists,
} from "./lib/obsidian-vault";
import { folderPathForFile } from "./lib/path";
import { listLocalEntries } from "./file-sync/local-entries";
import {
	ARG_CHUNK_SIZE,
	isDotObsidianPath,
	shouldIgnoreVaultPath,
} from "./file-sync/path-rules";
import {
	readRemoteFileBytes,
	sha256Bytes,
	uploadLocalFile,
} from "./file-sync/remote-transfer";
import type { FileSyncHost, Snapshot } from "./file-sync/types";

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
			.filter((row) => !shouldIgnoreVaultPath(row.path))
			.map((row) => [row.path, row]),
	);
	for (const remoteFolder of snapshot.folders) {
		if (!remoteFolder.isExplicitlyEmpty) {
			continue;
		}
		const existing = host.app.vault.getAbstractFileByPath(remoteFolder.path);
		if (!existing) {
			await ensureVaultFolderExists(host.app, remoteFolder.path);
		}
	}

	const localState = await listLocalEntries(host);
	const localFiles = localState.files;
	const remoteSyncedFileCount = snapshot.files.filter(
		(file) => !shouldIgnoreVaultPath(file.path),
	).length;
	const totalSteps = localFiles.length + remoteSyncedFileCount + 2;
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
		if (shouldIgnoreVaultPath(remoteFile.path)) {
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
		if (isDotObsidianPath(remoteFile.path)) {
			await ensureAdapterFolderExists(host.app, parent);
		} else {
			await ensureVaultFolderExists(host.app, parent);
		}
		if (isDotObsidianPath(remoteFile.path)) {
			await host.app.vault.adapter.writeBinary(remoteFile.path, remotePayload.bytes);
		} else {
			await host.app.vault.createBinary(remoteFile.path, remotePayload.bytes);
		}
		localPaths.add(remoteFile.path);
		tick("Creating missing local files");
	}

	const folderPaths = localState.folders.filter((path) => normalizePath(path).trim() !== "");
	const emptyFolderPaths = localState.emptyFolders.filter(
		(path) => normalizePath(path).trim() !== "",
	);
	await client.mutation(api.fileSync.syncFolderState, {
		convexSecret: secret,
		scannedAtMs: Date.now(),
		clientId,
		folderPaths,
		emptyFolderPaths,
	});
	tick("Syncing folder state");

	const removedRemotePaths = snapshot.files
		.map((file) => file.path)
		.filter((path) => !shouldIgnoreVaultPath(path))
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
