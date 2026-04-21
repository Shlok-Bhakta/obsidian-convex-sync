import { Notice } from "obsidian";
import type { MyPluginSettings } from "../settings";

const MINT_PATH = "/obsidian-convex-sync/mint-vault-api-secret";

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
		new Notice(`Convex: could not obtain vault API key: ${message}`, 10000);
		console.error(err);
		return null;
	}
}

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
	const secret = await fetchMintedVaultApiSecret(options.settings.convexSiteUrl);
	if (!secret) {
		return false;
	}
	options.settings.convexSecret = secret;
	await options.saveSettings();
	new Notice("Convex: vault API key saved.", 6000);
	await options.ensureRegistered();
	return true;
}
