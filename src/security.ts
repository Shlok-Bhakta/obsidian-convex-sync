import { ConvexHttpClient } from "convex/browser";
import { Notice } from "obsidian";
import { api } from "../convex/_generated/api";
import type { MyPluginSettings } from "./settings";

const MINT_PATH = "/obsidian-convex-sync/mint-vault-api-secret";

/**
 * POST to the deployment site mint route; returns the secret body or null on failure.
 * Server-side generation (Convex Node `randomUUID`); no client-side crypto.
 */
export async function fetchMintedVaultApiSecret(
	convexSiteUrl: string,
): Promise<string | null> {
	const base = convexSiteUrl.trim().replace(/\/$/, "");
	if (!base) {
		new Notice(
			"Convex: set Convex site URL in settings to obtain a vault API key.",
			10000,
		);
		return null;
	}
	const url = `${base}${MINT_PATH}`;
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			cache: "no-store",
		});
		const text = await res.text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch {
			new Notice(
				`Convex: invalid response from vault key mint (${res.status}).`,
				10000,
			);
			return null;
		}
		if (!parsed || typeof parsed !== "object") {
			new Notice("Convex: unexpected mint response.", 8000);
			return null;
		}
		const body = parsed as {
			ok?: unknown;
			secret?: unknown;
			message?: unknown;
		};
		if (
			body.ok === true &&
			typeof body.secret === "string" &&
			body.secret.length > 0
		) {
			return body.secret;
		}
		if (body.ok === false) {
			const msg =
				typeof body.message === "string" && body.message.length > 0
					? body.message
					: "Access denied: uuid already registered for this deployment.";
			new Notice(msg, 12000);
			return null;
		}
		new Notice("Convex: unexpected mint response.", 8000);
		return null;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		new Notice(
			`Convex: could not obtain vault API key: ${message}`,
			10000,
		);
		console.error(err);
		return null;
	}
}

/**
 * Registers this vault's API key with Convex when the table is empty, or verifies it matches.
 * Skipped when URL is unchanged and registration already succeeded.
 */
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
		new Notice(
			`Convex: could not register vault API key: ${message}`,
			10000,
		);
		console.error(err);
	}
}

/**
 * Fetches a one-time vault API key from Convex HTTP. Call when {@link MyPluginSettings.convexSecret} is empty.
 */
export async function mintVaultApiSecretFromConvexSite(options: {
	settings: MyPluginSettings;
	saveSettings: () => Promise<void>;
	ensureRegistered: () => Promise<void>;
}): Promise<boolean> {
	if (options.settings.convexSecret.trim() !== "") {
		new Notice(
			"Convex: this vault already has an API key. Clear plugin data only if you intend to replace it.",
			10000,
		);
		return false;
	}
	const secret = await fetchMintedVaultApiSecret(
		options.settings.convexSiteUrl,
	);
	if (!secret) {
		return false;
	}
	options.settings.convexSecret = secret;
	await options.saveSettings();
	new Notice("Convex: vault API key saved.", 6000);
	await options.ensureRegistered();
	return true;
}
