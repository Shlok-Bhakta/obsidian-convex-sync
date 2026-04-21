import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { App, Editor, MarkdownView, Modal, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { api } from "../convex/_generated/api";
import {
	ClientsPresenceView,
	CLIENTS_PRESENCE_VIEW_TYPE,
	leaveClientsPresence,
	revealClientsPresenceView,
	startClientsPresence,
} from "./clients-presence";
import { createConvexHttpClient } from "./convex-client";
import {
	ensureVaultSecretRegisteredWithDeployment,
	mintVaultApiSecretFromConvexSite,
} from "./security";
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	SampleSettingTab,
} from "./settings";

// Remember to rename these classes and interfaces!

export default class MyPlugin extends Plugin {
	settings: MyPluginSettings;
	/**
	 * New UUID on every plugin load. Not persisted (avoids synced `.obsidian` giving every device the same id).
	 * Convex `clientId` / leave / heartbeat all use this.
	 */
	private presenceSessionId = "";
	private convexHttpClientCache: { client: ConvexHttpClient; url: string } | null =
		null;
	private convexRealtimeClientCache: {
		client: ConvexClient;
		url: string;
	} | null = null;

	getPresenceSessionId(): string {
		return this.presenceSessionId;
	}

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

	/**
	 * WebSocket client for live queries (e.g. connected clients). Recreated when the deployment URL changes.
	 */
	getConvexRealtimeClient(): ConvexClient | null {
		const url = this.settings.convexUrl.trim();
		const secret = this.settings.convexSecret.trim();
		if (!url || !secret) {
			void this.convexRealtimeClientCache?.client.close();
			this.convexRealtimeClientCache = null;
			return null;
		}
		if (
			!this.convexRealtimeClientCache ||
			this.convexRealtimeClientCache.url !== url
		) {
			void this.convexRealtimeClientCache?.client.close();
			this.convexRealtimeClientCache = {
				client: new ConvexClient(url),
				url,
			};
		}
		return this.convexRealtimeClientCache.client;
	}

	async onload() {
		await this.loadSettings();
		this.presenceSessionId = crypto.randomUUID();
		await this.ensureConvexSecretRegisteredWithDeployment();

		this.registerView(
			CLIENTS_PRESENCE_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new ClientsPresenceView(leaf, this),
		);

		const stopClientsPresence = startClientsPresence(this);
		this.register(() => {
			stopClientsPresence();
		});

		this.addRibbonIcon("users", "Open connected clients", () => {
			void revealClientsPresenceView(this.app);
		});

		this.addCommand({
			id: "open-connected-clients",
			name: "Open connected clients",
			callback: () => {
				void revealClientsPresenceView(this.app);
			},
		});

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
		void leaveClientsPresence(this);
		void this.convexRealtimeClientCache?.client.close();
		this.convexRealtimeClientCache = null;
		this.convexHttpClientCache = null;
	}

	async loadSettings() {
		const disk = (await this.loadData()) as Record<string, unknown> &
			Partial<MyPluginSettings>;
		const { presenceClientId: _legacyPresenceId, ...rest } = disk;
		void _legacyPresenceId;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, rest);
	}

	/** Delegates to {@link mintVaultApiSecretFromConvexSite} for settings UI. */
	async mintVaultSecretFromDeployment(): Promise<boolean> {
		return mintVaultApiSecretFromConvexSite({
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
			ensureRegistered: () =>
				this.ensureConvexSecretRegisteredWithDeployment(),
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async ensureConvexSecretRegisteredWithDeployment(): Promise<void> {
		return ensureVaultSecretRegisteredWithDeployment({
			convexUrl: this.settings.convexUrl,
			convexSecret: this.settings.convexSecret,
			convexSecretDeployedToUrl: this.settings.convexSecretDeployedToUrl,
			getClient: () => this.getConvexHttpClient(),
			markSecretDeployedToUrl: async url => {
				this.settings.convexSecretDeployedToUrl = url;
				await this.saveSettings();
			},
		});
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
