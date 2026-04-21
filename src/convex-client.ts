import { ConvexHttpClient } from "convex/browser";
import type { MyPluginSettings } from "./settings";

/**
 * Deployment client for queries, mutations, and actions.
 * Uses the deployment URL from plugin settings (not process env).
 */
export function createConvexHttpClient(
	settings: Pick<MyPluginSettings, "convexUrl">,
): ConvexHttpClient {
	const url = settings.convexUrl.trim();
	if (!url) {
		throw new Error(
			"Convex URL is empty. Open plugin settings and set Convex URL (deployment URL).",
		);
	}
	return new ConvexHttpClient(url);
}

/** Origin for Convex HTTP routes / actions (`CONVEX_SITE_URL`), no trailing slash. */
export function convexSiteOrigin(
	settings: Pick<MyPluginSettings, "convexSiteUrl">,
): string {
	const raw = settings.convexSiteUrl.trim();
	if (!raw) {
		throw new Error(
			"Convex site URL is empty. Open plugin settings and set Convex site URL.",
		);
	}
	return raw.replace(/\/+$/, "");
}

/** Shared secret for backend verification; pair with mutation args or headers you define. */
export function convexSharedSecret(
	settings: Pick<MyPluginSettings, "convexSecret">,
): string {
	return settings.convexSecret;
}
