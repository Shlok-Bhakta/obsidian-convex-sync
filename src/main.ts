import { ConvexHttpClient } from "convex/browser";
import {App, Editor, MarkdownView, Modal, Notice, Plugin} from 'obsidian';
import { api } from "../convex/_generated/api";
import { createConvexHttpClient } from "./convex-client";
import {DEFAULT_SETTINGS, MyPluginSettings, SampleSettingTab} from "./settings";

// Remember to rename these classes and interfaces!

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	private convexHttpClientCache: { client: ConvexHttpClient; url: string } | null =
		null;

	/**
	 * Convex HTTP client using **Settings → Convex URL**, not `.env.local`.
	 * Recreated when the deployment URL changes.
	 */
	getConvexHttpClient(): ConvexHttpClient {
		const url = this.settings.convexUrl.trim();
		if (
			!this.convexHttpClientCache ||
			this.convexHttpClientCache.url !== url
		) {
			this.convexHttpClientCache = {
				client: createConvexHttpClient(this.settings),
				url,
			};
		}
		return this.convexHttpClientCache.client;
	}

	async onload() {
		await this.loadSettings();
		await this.ensureConvexSecretRegisteredWithDeployment();

		// Dev: click the dice ribbon to fetch a random Convex task (reload Obsidian after rebuild).
		this.addRibbonIcon("dice", "Convex sample task", () => {
			void this.showRandomTaskNotice();
		});

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status bar text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-modal-simple',
			name: 'Open modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'replace-selected',
			name: 'Replace selected content',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				editor.replaceSelection('Sample editor command');
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-modal-complex',
			name: 'Open modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new SampleModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
				return false;
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));

	}

	onunload() {
		this.convexHttpClientCache = null;
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MyPluginSettings>,
		);
	}

	/**
	 * Fetches a one-time vault API key from Convex HTTP (server-side Node `randomUUID`).
	 * Call from settings after Convex site URL is set. No client-side crypto.
	 */
	async mintVaultSecretFromDeployment(): Promise<boolean> {
		if (this.settings.convexSecret.trim() !== "") {
			new Notice(
				"Convex: this vault already has an API key. Clear plugin data only if you intend to replace it.",
				10000,
			);
			return false;
		}
		const secret = await this.requestMintedSecretFromConvexSite();
		if (!secret) {
			return false;
		}
		this.settings.convexSecret = secret;
		await this.saveData(this.settings);
		new Notice("Convex: vault API key saved.", 6000);
		await this.ensureConvexSecretRegisteredWithDeployment();
		return true;
	}

	/**
	 * POST to the deployment site mint route; returns the secret body or null on failure.
	 */
	private async requestMintedSecretFromConvexSite(): Promise<string | null> {
		const base = this.settings.convexSiteUrl.trim().replace(/\/$/, "");
		if (!base) {
			new Notice(
				"Convex: set Convex site URL in settings to obtain a vault API key.",
				10000,
			);
			return null;
		}
		const url = `${base}/obsidian-convex-sync/mint-vault-api-secret`;
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
			const message =
				err instanceof Error ? err.message : String(err);
			new Notice(
				`Convex: could not obtain vault API key: ${message}`,
				10000,
			);
			console.error(err);
			return null;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/**
	 * Registers this vault's API key with Convex when the table is empty, or verifies it matches.
	 * Skipped when URL is unchanged and registration already succeeded.
	 */
	async ensureConvexSecretRegisteredWithDeployment(): Promise<void> {
		const url = this.settings.convexUrl.trim();
		if (!url || !this.settings.convexSecret.trim()) {
			return;
		}
		if (this.settings.convexSecretDeployedToUrl === url) {
			return;
		}
		try {
			const client = this.getConvexHttpClient();
			const result = await client.mutation(api.security.registerPluginSecret, {
				proposedSecret: this.settings.convexSecret,
			});
			if (!result.ok) {
				new Notice(result.message, 12000);
				return;
			}
			this.settings.convexSecretDeployedToUrl = url;
			await this.saveSettings();
		} catch (err) {
			const message =
				err instanceof Error ? err.message : String(err);
			new Notice(
				`Convex: could not register vault API key: ${message}`,
				10000,
			);
			console.error(err);
		}
	}

	private async showRandomTaskNotice(): Promise<void> {
		try {
			const client = this.getConvexHttpClient();
			const task = await client.query(api.tasks.getRandom, {
				convexSecret: this.settings.convexSecret,
			});
			if (task === null) {
				new Notice("Convex: no tasks yet.");
				return;
			}
			const suffix = task.isCompleted ? " (done)" : "";
			new Notice(`Convex: ${task.text}${suffix}`);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : String(err);
			new Notice(`Convex query failed: ${message}`, 8000);
			console.error(err);
		}
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		let {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}
