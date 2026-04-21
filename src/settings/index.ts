export interface MyPluginSettings {
	convexUrl: string;
	convexSiteUrl: string;
	convexSecret: string;
	convexSecretDeployedToUrl: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	convexUrl: "http://127.0.0.1:3210",
	convexSiteUrl: "http://127.0.0.1:3211",
	convexSecret: "",
	convexSecretDeployedToUrl: "",
};

export function normalizeLoadedSettings(raw: unknown): MyPluginSettings {
	const disk = (raw ?? {}) as Record<string, unknown> & Partial<MyPluginSettings> & {
		presenceClientId?: unknown;
	};
	const { presenceClientId: _legacyPresenceId, ...rest } = disk;
	void _legacyPresenceId;
	return Object.assign({}, DEFAULT_SETTINGS, rest);
}
