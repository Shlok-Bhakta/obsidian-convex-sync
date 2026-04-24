import { Notice, TAbstractFile, TFolder } from "obsidian";
import {
	pushVaultPathUpdate,
	pushVaultTextUpdate,
	renameRemoteVaultPath,
	runQueuedFileSync,
	runRemoteFileSync,
	runVaultFileSync,
	trashRemoteVaultPaths,
} from "./file-sync";
import { getConfigDir, isPathIgnored, parseIgnoreRules } from "./sync/policy";
import type { MyPluginSettings } from "./settings";

type LiveSyncHost = {
	app: import("obsidian").App;
	settings: MyPluginSettings;
	getConvexHttpClient: import("./file-sync").FileSyncHost["getConvexHttpClient"];
	getPresenceSessionId: import("./file-sync").FileSyncHost["getPresenceSessionId"];
	registerEvent: import("obsidian").Plugin["registerEvent"];
	registerInterval: import("obsidian").Plugin["registerInterval"];
	setSyncStatus(text: string): void;
	recordSyncDebug?(area: string, message: string, data?: Record<string, unknown>): void;
};

type Cleanup = () => void;

const CONFIG_SCAN_INTERVAL_MS = 400;
const REMOTE_POLL_INTERVAL_MS = 5000;

type SyncReason = "change" | "full" | "poll";

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
	const visited = new Set<string>();
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || visited.has(current) || shouldIgnorePath(host, current)) {
			continue;
		}
		visited.add(current);
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
		host.recordSyncDebug?.("live", "start skipped because disabled");
		host.setSyncStatus("Convex sync: live sync disabled");
		return () => {};
	}
	const secret = host.settings.convexSecret.trim();
	if (!secret) {
		host.recordSyncDebug?.("live", "start skipped because secret is missing");
		host.setSyncStatus("Convex sync: set Convex URL and secret first");
		return () => {};
	}
	host.recordSyncDebug?.("live", "started", {
		batchWindowMs: host.settings.editorBatchWindowMs,
		syncDotObsidian: host.settings.syncDotObsidian,
	});

	let stopped = false;
	let running = false;
	let flushTimer: number | null = null;
	let pendingReason: SyncReason | null = null;
	let lastConfigScan = new Map<string, number>();

	const runSync = async (reason: SyncReason): Promise<void> => {
		if (stopped) {
			return;
		}
		if (running) {
			host.recordSyncDebug?.("live", "sync already running; queued follow-up", { reason });
			pendingReason = reason === "full" || pendingReason === "full"
				? "full"
				: pendingReason === "change" || reason === "change"
					? "change"
					: "poll";
			return;
		}
		running = true;
		const showProgress = reason === "full";
		if (showProgress) {
			host.setSyncStatus("Convex sync: syncing");
		}
		try {
			host.recordSyncDebug?.("live", "sync started", { reason });
			const syncHost = {
				app: host.app,
				settings: host.settings,
				getConvexHttpClient: host.getConvexHttpClient,
				getPresenceSessionId: host.getPresenceSessionId,
				recordSyncDebug: host.recordSyncDebug,
			};
			if (reason === "poll") {
				await runRemoteFileSync(syncHost);
			} else if (reason === "change") {
				await runQueuedFileSync(syncHost);
			} else {
				await runVaultFileSync({
					...syncHost,
					reportSyncProgress: showProgress
						? ({ phase, completed, total }) => {
							const percent = total <= 0 ? 0 : Math.min(100, Math.round((completed / total) * 100));
							host.setSyncStatus(`Convex sync: ${percent}% (${completed}/${total}) - ${phase}`);
						}
						: undefined,
				});
			}
			lastConfigScan = await scanConfigFileMtims(host);
			host.setSyncStatus("Convex sync: live");
			host.recordSyncDebug?.("live", "sync finished", { reason });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			host.setSyncStatus("Convex sync: live failed");
			host.recordSyncDebug?.("live", "sync failed", { reason, message });
			new Notice(`Convex live sync failed: ${message}`, 10000);
			console.error(error);
		} finally {
			running = false;
			if (pendingReason !== null && !stopped) {
				const nextReason = pendingReason;
				pendingReason = null;
				scheduleSync(0, nextReason);
			}
		}
	};

	const scheduleSync = (delayMs: number, reason: SyncReason): void => {
		if (pendingReason === "full" || (pendingReason === "change" && reason === "poll")) {
			return;
		}
		pendingReason = reason === "full"
			? "full"
			: pendingReason === "change" || reason === "change"
				? "change"
				: "poll";
		if (flushTimer !== null) {
			window.clearTimeout(flushTimer);
		}
		flushTimer = window.setTimeout(() => {
			flushTimer = null;
			const nextReason = pendingReason ?? "poll";
			pendingReason = null;
			void runSync(nextReason);
		}, Math.max(0, delayMs));
	};

	const queuePathEvent = (path: string): void => {
		if (stopped || shouldIgnorePath(host, path)) {
			return;
		}
		host.recordSyncDebug?.("queue", "path update", { path });
		void pushVaultPathUpdate(host as never, path);
		scheduleSync(host.settings.editorBatchWindowMs, "change");
	};

	const queueEditorText = (path: string, text: string): void => {
		if (stopped || shouldIgnorePath(host, path) || isConfigPath(host, path)) {
			return;
		}
		host.recordSyncDebug?.("queue", "editor text update", { path, length: text.length });
		void pushVaultTextUpdate(host as never, path, text, Date.now());
		scheduleSync(host.settings.editorBatchWindowMs, "change");
	};

	const queueDelete = (path: string): void => {
		if (stopped || shouldIgnorePath(host, path)) {
			return;
		}
		host.recordSyncDebug?.("queue", "delete", { path });
		void trashRemoteVaultPaths(host as never, [path]);
		scheduleSync(host.settings.editorBatchWindowMs, "change");
	};

	const queueRename = (file: TAbstractFile, oldPath: string): void => {
		if (stopped) {
			return;
		}
		if (shouldIgnorePath(host, oldPath) && shouldIgnorePath(host, file.path)) {
			return;
		}
		host.recordSyncDebug?.("queue", "rename", { oldPath, newPath: file.path });
		void renameRemoteVaultPath(host as never, oldPath, file.path);
		scheduleSync(host.settings.editorBatchWindowMs, "change");
	};

	host.registerEvent(host.app.vault.on("create", (file) => {
		if (file instanceof TFolder) {
			return;
		}
		if (file instanceof TAbstractFile) {
			queuePathEvent(file.path);
		}
	}));
	host.registerEvent(host.app.vault.on("modify", (file) => {
		if (file instanceof TFolder) {
			return;
		}
		if (file instanceof TAbstractFile) {
			queuePathEvent(file.path);
		}
	}));
	host.registerEvent(host.app.vault.on("delete", (file) => {
		if (file instanceof TFolder) {
			return;
		}
		if (file instanceof TAbstractFile) {
			queueDelete(file.path);
		}
	}));
	host.registerEvent(host.app.vault.on("rename", (file, oldPath) => {
		if (file instanceof TFolder) {
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
			if (stopped || !host.settings.syncDotObsidian) {
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

	const remotePollInterval = window.setInterval(() => {
		scheduleSync(0, "poll");
	}, REMOTE_POLL_INTERVAL_MS);
	host.registerInterval(remotePollInterval);

	void scanConfigFileMtims(host).then((scan) => {
		lastConfigScan = scan;
	});
	scheduleSync(0, "full");

	return () => {
		stopped = true;
		host.recordSyncDebug?.("live", "stopped");
		if (flushTimer !== null) {
			window.clearTimeout(flushTimer);
		}
	};
}
