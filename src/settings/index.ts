export interface MyPluginSettings {
	convexUrl: string;
	convexSiteUrl: string;
	convexSecret: string;
	convexSecretDeployedToUrl: string;
	/**
	 * When true, skips client-side delays after binary uploads and between download chunks.
	 * Those delays exist to reduce Convex Cloud "write bandwidth" / burst errors; self-hosted
	 * backends often do not need them. Does not change Convex function payload size limits.
	 */
	relaxBinarySyncBandwidthPacing: boolean;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	convexUrl: "http://127.0.0.1:3210",
	convexSiteUrl: "http://127.0.0.1:3211",
	convexSecret: "",
	convexSecretDeployedToUrl: "",
	relaxBinarySyncBandwidthPacing: false,
};

export function normalizeLoadedSettings(raw: unknown): MyPluginSettings {
	const disk = (raw ?? {}) as Record<string, unknown> & Partial<MyPluginSettings> & {
		presenceClientId?: unknown;
	};
	const { presenceClientId: _legacyPresenceId, ...rest } = disk;
	void _legacyPresenceId;
	return Object.assign({}, DEFAULT_SETTINGS, rest);
}
