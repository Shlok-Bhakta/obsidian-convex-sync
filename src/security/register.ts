import { ConvexHttpClient } from "convex/browser";
import { Notice } from "obsidian";
import { api } from "../../convex/_generated/api";

export async function ensureVaultSecretRegisteredWithDeployment(options: {
	convexUrl: string;
	convexSecret: string;
	convexSecretDeployedToUrl: string;
	getClient: () => ConvexHttpClient;
	markSecretDeployedToUrl: (url: string) => Promise<void>;
}): Promise<void> {
	const url = options.convexUrl.trim();
	if (!url || !options.convexSecret.trim()) {
		return;
	}
	if (options.convexSecretDeployedToUrl === url) {
		return;
	}
	try {
		const client = options.getClient();
		const result = await client.mutation(api.security.registerPluginSecret, {
			proposedSecret: options.convexSecret,
		});
		if (!result.ok) {
			new Notice(result.message, 12000);
			return;
		}
		await options.markSecretDeployedToUrl(url);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		new Notice(`Convex: could not register vault API key: ${message}`, 10000);
		console.error(err);
	}
}
