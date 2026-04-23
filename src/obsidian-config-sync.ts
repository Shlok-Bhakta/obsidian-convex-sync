import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import { Notice, type App, type EventRef } from "obsidian";
import { api } from "../convex/_generated/api";
import type { MyPluginSettings } from "./settings";
import {
	collectTrackedObsidianState,
	ensureAdapterFolderExists,
	folderPathForFile,
	shouldTrackObsidianPath,
} from "./obsidian-config";
import { matchesSyncIgnorePath } from "./sync-ignore";

const OBSIDIAN_SYNC_POLL_MS = 2_000;

type SnapshotRow = {
	path: string;
	contentHash: string;
	sizeBytes: number;
	updatedAtMs: number;
	updatedByClientId: string;
};

type Snapshot = {
	files: SnapshotRow[];
};

type Unsubscribable = {
	(): void;
	unsubscribe(): void;
	getCurrentValue(): unknown;
};

export type ObsidianConfigSyncHost = {
	app: App;
	settings: MyPluginSettings;
	getConvexHttpClient(): ConvexHttpClient;
	getConvexRealtimeClient(): ConvexClient | null;
	getPresenceSessionId(): string;
	registerEvent(event: EventRef): void;
	registerInterval(id: number): void;
};

function canRun(host: ObsidianConfigSyncHost): boolean {
	return (
		host.settings.convexUrl.trim() !== "" &&
		host.settings.convexSecret.trim() !== "" &&
		host.getPresenceSessionId().trim() !== ""
	);
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

async function readRemoteFileBytes(
	client: ConvexHttpClient,
	secret: string,
	path: string,
): Promise<ArrayBuffer | null> {
	const signed = await client.query(api.fileSync.getDownloadUrl, {
		convexSecret: secret,
		path,
	});
	if (!signed?.url) {
		return null;
	}
	const response = await fetch(signed.url, { method: "GET", cache: "no-store" });
	if (!response.ok) {
		throw new Error(`Failed downloading ${path}: HTTP ${response.status}`);
	}
	return response.arrayBuffer();
}

async function uploadLocalFile(
	host: ObsidianConfigSyncHost,
	path: string,
	bytes: ArrayBuffer,
	updatedAtMs: number,
	contentHash: string,
): Promise<"ok" | "stale_write"> {
	const client = host.getConvexHttpClient();
	const blob = new Blob([bytes], { type: "application/octet-stream" });
	const issued = await client.mutation(api.fileSync.issueUploadUrl, {
		convexSecret: host.settings.convexSecret,
		path,
		contentHash,
		updatedAtMs,
		sizeBytes: blob.size,
		clientId: host.getPresenceSessionId(),
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
		convexSecret: host.settings.convexSecret,
		path,
		storageId: payload.storageId as never,
		contentHash,
		updatedAtMs,
		sizeBytes: blob.size,
		clientId: host.getPresenceSessionId(),
	});
	if (!finalized.ok && finalized.reason === "stale_write") {
		return "stale_write";
	}
	return "ok";
}

export function startObsidianConfigSync(host: ObsidianConfigSyncHost): () => void {
	const teardowns: Array<() => void> = [];
	let remoteFiles = new Map<string, SnapshotRow>();
	let previousRemoteFiles = new Map<string, SnapshotRow>();
	let remoteReady = false;
	let applyingRemote = false;
	let pendingRemoteApply = false;
	let scanningLocal = false;
	let pendingLocalScan = false;

	const queueLocalScan = (): void => {
		if (!remoteReady || !canRun(host)) {
			return;
		}
		if (scanningLocal) {
			pendingLocalScan = true;
			return;
		}
		void scanLocalChanges();
	};

	const queueRemoteApply = (): void => {
		if (!remoteReady || !canRun(host)) {
			return;
		}
		if (applyingRemote) {
			pendingRemoteApply = true;
			return;
		}
		void applyRemoteChanges();
	};

	const applyRemoteFile = async (path: string, bytes: ArrayBuffer): Promise<void> => {
		const parent = folderPathForFile(path);
		if (parent) {
			await ensureAdapterFolderExists(host.app, parent);
		}
		await host.app.vault.adapter.writeBinary(path, bytes);
	};

	const applyRemoteChanges = async (): Promise<void> => {
		applyingRemote = true;
		try {
			const localState = await collectTrackedObsidianState(
				host.app,
				host.settings.syncIgnorePaths,
			);
			const localByPath = new Map(localState.files.map((file) => [file.path, file]));
			for (const [path, remote] of remoteFiles) {
				const local = localByPath.get(path);
				if (!local) {
					const bytes = await readRemoteFileBytes(
						host.getConvexHttpClient(),
						host.settings.convexSecret,
						path,
					);
					if (bytes) {
						await applyRemoteFile(path, bytes);
					}
					continue;
				}
				if (remote.updatedAtMs > local.updatedAtMs) {
					const bytes = await readRemoteFileBytes(
						host.getConvexHttpClient(),
						host.settings.convexSecret,
						path,
					);
					if (bytes) {
						await applyRemoteFile(path, bytes);
					}
					continue;
				}
				if (remote.updatedAtMs === local.updatedAtMs) {
					const localBytes = await host.app.vault.adapter.readBinary(path);
					const localHash = await sha256Bytes(localBytes);
					if (localHash === remote.contentHash) {
						continue;
					}
					const localWins =
						host.getPresenceSessionId().localeCompare(remote.updatedByClientId) <= 0;
					if (!localWins) {
						const bytes = await readRemoteFileBytes(
							host.getConvexHttpClient(),
							host.settings.convexSecret,
							path,
						);
						if (bytes) {
							await applyRemoteFile(path, bytes);
						}
					}
				}
			}

			for (const [path, previousRemote] of previousRemoteFiles) {
				if (remoteFiles.has(path)) {
					continue;
				}
				const exists = await host.app.vault.adapter.exists(path);
				if (!exists) {
					continue;
				}
				const localBytes = await host.app.vault.adapter.readBinary(path);
				const localHash = await sha256Bytes(localBytes);
				if (localHash === previousRemote.contentHash) {
					await host.app.vault.adapter.remove(path);
				}
			}
		} finally {
			applyingRemote = false;
			if (pendingRemoteApply) {
				pendingRemoteApply = false;
				queueRemoteApply();
			}
		}
	};

	const scanLocalChanges = async (): Promise<void> => {
		scanningLocal = true;
		try {
			const localState = await collectTrackedObsidianState(
				host.app,
				host.settings.syncIgnorePaths,
			);
			const localByPath = new Map(localState.files.map((file) => [file.path, file]));
			for (const local of localState.files) {
				const remote = remoteFiles.get(local.path);
				const bytes = await host.app.vault.adapter.readBinary(local.path);
				const contentHash = await sha256Bytes(bytes);
				if (!remote) {
					await uploadLocalFile(host, local.path, bytes, local.updatedAtMs, contentHash);
					continue;
				}
				if (contentHash === remote.contentHash) {
					continue;
				}
				if (local.updatedAtMs > remote.updatedAtMs) {
					await uploadLocalFile(host, local.path, bytes, local.updatedAtMs, contentHash);
					continue;
				}
				if (local.updatedAtMs === remote.updatedAtMs) {
					const localWins =
						host.getPresenceSessionId().localeCompare(remote.updatedByClientId) <= 0;
					if (localWins) {
						await uploadLocalFile(host, local.path, bytes, local.updatedAtMs, contentHash);
					}
				}
			}

			const removedPaths = [...remoteFiles.keys()]
				.filter((path) => !matchesSyncIgnorePath(path, host.settings.syncIgnorePaths))
				.filter((path) => !localByPath.has(path));
			if (removedPaths.length > 0) {
				await host.getConvexHttpClient().mutation(api.fileSync.removeFilesByPath, {
					convexSecret: host.settings.convexSecret,
					removedPaths,
				});
			}
		} catch (error) {
			console.error(".obsidian sync failed", error);
		} finally {
			scanningLocal = false;
			if (pendingLocalScan) {
				pendingLocalScan = false;
				queueLocalScan();
			}
		}
	};

	if (!canRun(host)) {
		return () => teardowns.forEach((teardown) => teardown());
	}

	const client = host.getConvexRealtimeClient();
	if (!client) {
		return () => teardowns.forEach((teardown) => teardown());
	}

	const subscription = client.onUpdate(
		api.fileSync.listSnapshot,
		{ convexSecret: host.settings.convexSecret },
		(payload) => {
			previousRemoteFiles = remoteFiles;
			remoteFiles = new Map(
				((payload as Snapshot | null)?.files ?? [])
					.filter((file) => shouldTrackObsidianPath(file.path, host.settings.syncIgnorePaths))
					.map((file) => [file.path, file]),
			);
			remoteReady = true;
			queueRemoteApply();
		},
		(error) => {
			new Notice(`.obsidian sync subscription failed: ${error.message}`, 8000);
			console.error(error);
		},
	) as unknown as Unsubscribable;
	teardowns.push(() => subscription());
	const initial = subscription.getCurrentValue() as Snapshot | undefined;
	if (initial) {
		previousRemoteFiles = new Map();
		remoteFiles = new Map(
			initial.files
				.filter((file) => shouldTrackObsidianPath(file.path, host.settings.syncIgnorePaths))
				.map((file) => [file.path, file]),
		);
		remoteReady = true;
		queueRemoteApply();
	}

	const interval = window.setInterval(queueLocalScan, OBSIDIAN_SYNC_POLL_MS);
	host.registerInterval(interval);
	teardowns.push(() => window.clearInterval(interval));
	host.registerEvent(host.app.workspace.on("css-change", queueLocalScan));
	host.registerEvent(host.app.workspace.on("layout-change", queueLocalScan));

	return () => teardowns.forEach((teardown) => teardown());
}
