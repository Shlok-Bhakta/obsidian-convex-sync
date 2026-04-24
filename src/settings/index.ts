export interface MyPluginSettings {
	convexUrl: string;
	convexSiteUrl: string;
	convexSecret: string;
	convexSecretDeployedToUrl: string;
	enableLiveSync: boolean;
	binaryVersionRetentionCount: number;
	trashRetentionDays: number;
	editorBatchWindowMs: number;
	syncIgnorePaths: string;
	syncDotObsidian: boolean;
	enableDebugLogging: boolean;
}

export const DEFAULT_IGNORE_PATHS = [
	".trash",
	".obsidian/cache",
	".obsidian/workspace",
	".obsidian/workspace.json",
	".obsidian/workspace-mobile.json",
].join("\n");

export const DEFAULT_SETTINGS: MyPluginSettings = {
	convexUrl: "http://127.0.0.1:3210",
	convexSiteUrl: "http://127.0.0.1:3211",
	convexSecret: "",
	convexSecretDeployedToUrl: "",
	enableLiveSync: true,
	binaryVersionRetentionCount: 5,
	trashRetentionDays: 30,
	editorBatchWindowMs: 75,
	syncIgnorePaths: DEFAULT_IGNORE_PATHS,
	syncDotObsidian: true,
	enableDebugLogging: false,
};

export function normalizeLoadedSettings(raw: unknown): MyPluginSettings {
	const disk = (raw ?? {}) as Record<string, unknown> & Partial<MyPluginSettings> & {
		presenceClientId?: unknown;
	};
	const { presenceClientId: _legacyPresenceId, ...rest } = disk;
	void _legacyPresenceId;
	const merged = Object.assign({}, DEFAULT_SETTINGS, rest);
	merged.binaryVersionRetentionCount = Math.max(
		0,
		Math.min(50, Math.round(merged.binaryVersionRetentionCount)),
	);
	merged.trashRetentionDays = Math.max(
		1,
		Math.min(365, Math.round(merged.trashRetentionDays)),
	);
	merged.editorBatchWindowMs = Math.max(
		25,
		Math.min(10_000, Math.round(merged.editorBatchWindowMs)),
	);
	if (typeof merged.syncIgnorePaths !== "string") {
		merged.syncIgnorePaths = DEFAULT_IGNORE_PATHS;
	}
	merged.enableDebugLogging = merged.enableDebugLogging === true;
	return merged;
}
