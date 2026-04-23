import { type ConvexClient, type ConvexHttpClient } from "convex/browser";
import { Notice, TAbstractFile, TFolder } from "obsidian";
import { api } from "../convex/_generated/api";
import {
	applyRemoteDelete,
	applyRemoteRename,
	applyRemoteVaultPath,
	pushVaultPathUpdate,
	pushVaultTextUpdate,
	renameRemoteVaultPath,
	runVaultFileSync,
	trashRemoteVaultPaths,
} from "./file-sync";
import { resolveClientId } from "./sync/client-id";
import { getConfigDir, isPathIgnored, parseIgnoreRules } from "./sync/policy";
import type { MyPluginSettings } from "./settings";

type Operation = {
	id: string;
	clientId: string;
	kind: "file_upsert" | "file_delete" | "path_rename";
	entryType: "file" | "folder";
	path: string;
	oldPath: string | null;
	updatedAtMs: number;
};

type LiveSyncHost = {
	app: import("obsidian").App;
	settings: MyPluginSettings;
	getConvexRealtimeClient(): ConvexClient | null;
	getConvexHttpClient(): ConvexHttpClient;
	getPresenceSessionId(): string;
	registerEvent: import("obsidian").Plugin["registerEvent"];
	registerInterval: import("obsidian").Plugin["registerInterval"];
	setSyncStatus(text: string): void;
};

type Cleanup = () => void;

const EDITOR_SYNC_DEBOUNCE_MS = 40;
const CONFIG_SCAN_INTERVAL_MS = 400;

function isConfigPath(host: LiveSyncHost, path: string): boolean {
	const configDir = getConfigDir(host.app);
	return path === configDir || path.startsWith(`${configDir}/`);
}

function shouldIgnorePath(host: LiveSyncHost, path: string): boolean {
	const configDir = getConfigDir(host.app);
	const ignored = parseIgnoreRules(host.settings, configDir);
	if (!host.settings.syncDotObsidian && isConfigPath(host, path)) {
		return true;
	}
	return isPathIgnored(path, ignored);
}

async function scanConfigFileMtims(host: LiveSyncHost): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	if (!host.settings.syncDotObsidian) {
		return result;
	}

	const configDir = getConfigDir(host.app);
	if (shouldIgnorePath(host, configDir) || !(await host.app.vault.adapter.exists(configDir))) {
		return result;
	}

	const queue: string[] = [configDir];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || shouldIgnorePath(host, current)) {
			continue;
		}
		const listed = await host.app.vault.adapter.list(current);
		for (const filePath of listed.files) {
			if (shouldIgnorePath(host, filePath)) {
				continue;
			}
			const stat = await host.app.vault.adapter.stat(filePath);
			if (stat?.type === "file") {
				result.set(filePath, stat.mtime);
			}
		}
		for (const folderPath of listed.folders) {
			queue.push(folderPath);
		}
	}

	return result;
}

export function startLiveSync(host: LiveSyncHost): Cleanup {
	if (!host.settings.enableLiveSync) {
		host.setSyncStatus("Convex sync: live sync disabled");
		return () => {};
	}

	const secret = host.settings.convexSecret.trim();
	if (!secret) {
		host.setSyncStatus("Convex sync: set Convex URL and secret first");
		return () => {};
	}

	const pendingUpserts = new Set<string>();
	const pendingDeletes = new Set<string>();
	const pendingRenames: Array<{ oldPath: string; newPath: string }> = [];
	const pendingEditorTexts = new Map<string, { text: string; updatedAtMs: number }>();
	const seenOperationIds = new Set<string>();
	let fullReconcileQueued = false;
	let flushTimer: number | null = null;
	let flushDueAtMs = 0;
	let stopped = false;
	let primedRemoteFeed = false;
	let applyingRemote = false;
	let flushing = false;
	let rerunFlush = false;
	let lastConfigScan = new Map<string, number>();

	const runReconcileNow = async (): Promise<void> => {
		host.setSyncStatus("Convex sync: reconciling");
		await runVaultFileSync({
			app: host.app,
			settings: host.settings,
			getConvexHttpClient: host.getConvexHttpClient,
			getPresenceSessionId: host.getPresenceSessionId,
			reportSyncProgress: ({ phase, completed, total }) => {
				const percent =
					total <= 0 ? 0 : Math.min(100, Math.round((completed / total) * 100));
				host.setSyncStatus(
					`Convex sync: ${percent}% (${completed}/${total}) - ${phase}`,
				);
			},
		});
		host.setSyncStatus("Convex sync: live");
	};

	const flush = async (): Promise<void> => {
		if (stopped || applyingRemote) {
			return;
		}
		if (flushing) {
			rerunFlush = true;
			return;
		}
		flushing = true;
		try {
			while (pendingRenames.length > 0) {
				const rename = pendingRenames.shift();
				if (!rename) {
					continue;
				}
				await renameRemoteVaultPath(host as never, rename.oldPath, rename.newPath);
			}

			if (pendingDeletes.size > 0) {
				const deletions = [...pendingDeletes];
				pendingDeletes.clear();
				await trashRemoteVaultPaths(host as never, deletions);
			}

			for (const [path, payload] of [...pendingEditorTexts.entries()]) {
				pendingEditorTexts.delete(path);
				await pushVaultTextUpdate(host as never, path, payload.text, payload.updatedAtMs);
			}

			for (const path of [...pendingUpserts]) {
				if (pendingEditorTexts.has(path)) {
					continue;
				}
				pendingUpserts.delete(path);
				await pushVaultPathUpdate(host as never, path);
			}

			if (fullReconcileQueued) {
				fullReconcileQueued = false;
				await runReconcileNow();
			}

			host.setSyncStatus("Convex sync: live");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			host.setSyncStatus("Convex sync: live failed");
			new Notice(`Convex live sync failed: ${message}`, 10000);
			console.error(error);
		} finally {
			flushing = false;
			if (rerunFlush) {
				rerunFlush = false;
				void flush();
			}
		}
	};

	const scheduleFlush = (delayMs: number): void => {
		const dueAtMs = Date.now() + Math.max(0, delayMs);
		if (flushTimer !== null && flushDueAtMs <= dueAtMs) {
			return;
		}
		if (flushTimer !== null) {
			window.clearTimeout(flushTimer);
		}
		flushDueAtMs = dueAtMs;
		flushTimer = window.setTimeout(() => {
			flushTimer = null;
			flushDueAtMs = 0;
			void flush();
		}, Math.max(0, dueAtMs - Date.now()));
	};

	const queuePathEvent = (path: string): void => {
		if (stopped || applyingRemote || shouldIgnorePath(host, path)) {
			return;
		}
		if (pendingEditorTexts.has(path)) {
			scheduleFlush(EDITOR_SYNC_DEBOUNCE_MS);
			return;
		}
		pendingDeletes.delete(path);
		pendingUpserts.add(path);
		scheduleFlush(host.settings.editorBatchWindowMs);
	};

	const queueEditorText = (path: string, text: string): void => {
		if (stopped || applyingRemote || shouldIgnorePath(host, path) || isConfigPath(host, path)) {
			return;
		}
		pendingDeletes.delete(path);
		pendingUpserts.delete(path);
		pendingEditorTexts.set(path, { text, updatedAtMs: Date.now() });
		scheduleFlush(EDITOR_SYNC_DEBOUNCE_MS);
	};

	const queueDelete = (path: string): void => {
		if (stopped || applyingRemote || shouldIgnorePath(host, path)) {
			return;
		}
		pendingEditorTexts.delete(path);
		pendingUpserts.delete(path);
		pendingDeletes.add(path);
		scheduleFlush(host.settings.editorBatchWindowMs);
	};

	const queueRename = (file: TAbstractFile, oldPath: string): void => {
		if (stopped || applyingRemote) {
			return;
		}
		if (shouldIgnorePath(host, oldPath) && shouldIgnorePath(host, file.path)) {
			return;
		}
		pendingEditorTexts.delete(oldPath);
		pendingEditorTexts.delete(file.path);
		pendingRenames.push({ oldPath, newPath: file.path });
		scheduleFlush(host.settings.editorBatchWindowMs);
	};

	const queueFolderReconcile = (): void => {
		fullReconcileQueued = true;
		scheduleFlush(host.settings.editorBatchWindowMs);
	};

	host.registerEvent(host.app.vault.on("create", (file) => {
		if (file instanceof TFolder) {
			queueFolderReconcile();
			return;
		}
		if (file instanceof TAbstractFile) {
			queuePathEvent(file.path);
		}
	}));
	host.registerEvent(host.app.vault.on("modify", (file) => {
		if (file instanceof TFolder) {
			queueFolderReconcile();
			return;
		}
		if (file instanceof TAbstractFile) {
			queuePathEvent(file.path);
		}
	}));
	host.registerEvent(host.app.vault.on("delete", (file) => {
		if (file instanceof TFolder) {
			queueFolderReconcile();
			return;
		}
		if (file instanceof TAbstractFile) {
			queueDelete(file.path);
		}
	}));
	host.registerEvent(host.app.vault.on("rename", (file, oldPath) => {
		if (file instanceof TFolder) {
			queueFolderReconcile();
			return;
		}
		queueRename(file, oldPath);
	}));
	host.registerEvent(host.app.workspace.on("editor-change", (editor, info) => {
		const path = info.file?.path;
		if (!path) {
			return;
		}
		queueEditorText(path, editor.getValue());
	}));
	host.registerEvent(host.app.workspace.on("quick-preview", (file, data) => {
		queueEditorText(file.path, data);
	}));

	const configPollInterval = window.setInterval(() => {
		void (async () => {
			if (stopped || applyingRemote || !host.settings.syncDotObsidian) {
				return;
			}
			const nextScan = await scanConfigFileMtims(host);
			for (const [path, mtime] of nextScan) {
				if ((lastConfigScan.get(path) ?? 0) !== mtime) {
					queuePathEvent(path);
				}
			}
			for (const path of lastConfigScan.keys()) {
				if (!nextScan.has(path)) {
					queueDelete(path);
				}
			}
			lastConfigScan = nextScan;
		})().catch((error) => {
			console.error("Convex config scan failed", error);
		});
	}, CONFIG_SCAN_INTERVAL_MS);
	host.registerInterval(configPollInterval);

	const realtime = host.getConvexRealtimeClient();
	if (!realtime) {
		host.setSyncStatus("Convex sync: manual fallback");
		fullReconcileQueued = true;
		scheduleFlush(0);
		return () => {
			stopped = true;
			if (flushTimer !== null) {
				window.clearTimeout(flushTimer);
			}
		};
	}

	const applyOperations = async (ops: Operation[]): Promise<void> => {
		const unseen = ops.filter((op) => !seenOperationIds.has(op.id));
		for (const op of unseen) {
			seenOperationIds.add(op.id);
		}
		if (!primedRemoteFeed) {
			primedRemoteFeed = true;
			host.setSyncStatus("Convex sync: starting live sync");
			fullReconcileQueued = true;
			scheduleFlush(0);
			return;
		}
		const localClientId = resolveClientId(host);
		const remoteOps = unseen.filter((op) => op.clientId !== localClientId);
		if (remoteOps.length === 0) {
			return;
		}
		applyingRemote = true;
		try {
			for (const op of remoteOps) {
				switch (op.kind) {
					case "file_upsert":
						await applyRemoteVaultPath(host as never, op.path);
						break;
					case "file_delete":
						await applyRemoteDelete(host as never, op.path);
						break;
					case "path_rename":
						if (op.oldPath) {
							await applyRemoteRename(host as never, op.oldPath, op.path);
						}
						break;
				}
			}
			if (fullReconcileQueued) {
				scheduleFlush(0);
			} else {
				host.setSyncStatus("Convex sync: live");
			}
		} finally {
			applyingRemote = false;
		}
	};

	const unsubscribe: any = realtime.onUpdate(
		api.fileSync.listRecentOperations,
		{ convexSecret: secret, limit: 500 },
		(ops) => {
			void applyOperations(ops as Operation[]);
		},
		(error) => {
			host.setSyncStatus("Convex sync: live fallback");
			console.error(error);
		},
	) as (() => void) | { (): void; unsubscribe(): void };

	void scanConfigFileMtims(host).then((scan) => {
		lastConfigScan = scan;
	});

	return () => {
		stopped = true;
		if (flushTimer !== null) {
			window.clearTimeout(flushTimer);
			flushTimer = null;
		}
		if (typeof unsubscribe === "function") {
			unsubscribe();
			return;
		}
		if (unsubscribe && typeof unsubscribe.unsubscribe === "function") {
			unsubscribe.unsubscribe();
		}
	};
}
