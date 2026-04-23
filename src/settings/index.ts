import { DEFAULT_SYNC_IGNORE_PATHS, normalizeSyncIgnorePaths } from "../sync-ignore";

export interface MyPluginSettings {
	convexUrl: string;
	convexSiteUrl: string;
	convexSecret: string;
	convexSecretDeployedToUrl: string;
	syncIgnorePaths: string[];
	binaryVersionRetention: number;
	trashRetentionDays: number;
	liveSyncEnabled: boolean;
	editorKeystrokeBatchMs: number;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	convexUrl: "http://127.0.0.1:3210",
	convexSiteUrl: "http://127.0.0.1:3211",
	convexSecret: "",
	convexSecretDeployedToUrl: "",
	syncIgnorePaths: [...DEFAULT_SYNC_IGNORE_PATHS],
	binaryVersionRetention: 5,
	trashRetentionDays: 30,
	liveSyncEnabled: true,
	editorKeystrokeBatchMs: 15,
};

export function normalizeLoadedSettings(raw: unknown): MyPluginSettings {
	const disk = (raw ?? {}) as Record<string, unknown> & Partial<MyPluginSettings> & {
		presenceClientId?: unknown;
	};
	const { presenceClientId: _legacyPresenceId, ...rest } = disk;
	void _legacyPresenceId;
	return {
		...DEFAULT_SETTINGS,
		...rest,
		syncIgnorePaths: normalizeSyncIgnorePaths(disk.syncIgnorePaths),
		binaryVersionRetention:
			typeof disk.binaryVersionRetention === "number"
				? disk.binaryVersionRetention
				: DEFAULT_SETTINGS.binaryVersionRetention,
		trashRetentionDays:
			typeof disk.trashRetentionDays === "number"
				? disk.trashRetentionDays
				: DEFAULT_SETTINGS.trashRetentionDays,
		liveSyncEnabled:
			typeof disk.liveSyncEnabled === "boolean"
				? disk.liveSyncEnabled
				: DEFAULT_SETTINGS.liveSyncEnabled,
		editorKeystrokeBatchMs:
			typeof disk.editorKeystrokeBatchMs === "number"
				? disk.editorKeystrokeBatchMs
				: DEFAULT_SETTINGS.editorKeystrokeBatchMs,
	};
}
