import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import {
	ClientsPresenceView,
	CLIENTS_PRESENCE_VIEW_TYPE,
	leaveClientsPresence,
	revealClientsPresenceView,
	startClientsPresence,
} from "./clients-presence";
import { ConvexClientManager } from "./convex/client-manager";
import { runVaultFileSync } from "./file-sync";
import { api } from "../convex/_generated/api";
import {
	ensureVaultSecretRegisteredWithDeployment,
	mintVaultApiSecretFromConvexSite,
} from "./security";
import {
	normalizeLoadedSettings,
	DEFAULT_SETTINGS,
	ConvexSyncSettingTab,
	type MyPluginSettings,
} from "./settings";
import { BinarySyncManager } from "./sync/binary-sync-manager";
import { DocManager } from "./sync/doc-manager";

export default class ObsidianConvexSyncPlugin extends Plugin {
	settings: MyPluginSettings = { ...DEFAULT_SETTINGS };
	private presenceSessionId = "";
	private convex = new ConvexClientManager(() => this.settings);
	private syncStatusBarItemEl: HTMLElement | null = null;
	private binarySync: BinarySyncManager | null = null;
	private docManager: DocManager | null = null;

	getPresenceSessionId(): string {
		return this.presenceSessionId;
	}

	getConvexHttpClient = () => this.convex.getHttp();
	getConvexRealtimeClient = () => this.convex.getRealtime();
	getKeepaliveHttpClient = () => this.convex.getKeepaliveHttp();

	getDocAwareness() {
		return this.docManager?.getCurrentAwareness() ?? null;
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

		this.addCommand({
			id: "sync-vault-files",
			name: "Sync vault files with Convex",
			callback: () => {
				this.syncStatusBarItemEl?.setText("Convex sync: starting...");
				void runVaultFileSync({
					app: this.app,
					settings: this.settings,
					getConvexHttpClient: () => this.getConvexHttpClient(),
					getPresenceSessionId: () => this.getPresenceSessionId(),
					reportSyncProgress: ({ phase, completed, total }) => {
						const percent = total <= 0 ? 0 : Math.min(100, Math.round((completed / total) * 100));
						this.syncStatusBarItemEl?.setText(
							`Convex sync: ${percent}% (${completed}/${total}) - ${phase}`,
						);
					},
				})
					.then(() => {
						this.syncStatusBarItemEl?.setText("Convex sync: complete");
					})
					.catch((err: unknown) => {
						const message = err instanceof Error ? err.message : String(err);
						new Notice(`Convex sync failed: ${message}`, 10000);
						this.syncStatusBarItemEl?.setText("Convex sync: failed");
						console.error(err);
					});
			},
		});
		this.addCommand({
			id: "generate-bootstrap-link",
			name: "Generate vault bootstrap link (10 min)",
			callback: () => {
				new Notice(
					"Open plugin settings and use Bootstrap new device to generate the link.",
					6000,
				);
			},
		});

		this.syncStatusBarItemEl = this.addStatusBarItem();
		this.syncStatusBarItemEl.setText("Convex sync: idle");
		this.addSettingTab(new ConvexSyncSettingTab(this.app, this));

		const realtimeClient = this.convex.getRealtime();
		if (realtimeClient) {
			this.docManager = new DocManager(
				this.app,
				realtimeClient,
				api,
				this.presenceSessionId,
				this.settings.convexSecret.trim(),
			);
			this.registerEditorExtension(this.docManager.extensions);
			this.registerEvent(
				this.app.workspace.on("file-open", (file) => {
					if (file?.extension === "md") {
						void this.docManager?.onFileOpen(file.path);
					} else {
						void this.docManager?.closeCurrentDoc();
					}
				}),
			);
			this.register(() => {
				void this.docManager?.dispose();
				this.docManager = null;
			});

			this.binarySync = new BinarySyncManager(
				this.app,
				this.getConvexHttpClient(),
				realtimeClient,
				this.settings.convexSecret.trim(),
			);
			void this.binarySync.start().catch((err: unknown) => {
				console.error("Convex binary sync catch-up failed", err);
			});
			this.register(() => {
				this.binarySync?.dispose();
				this.binarySync = null;
			});
		}

	}

	onunload() {
		void leaveClientsPresence(this);
		this.binarySync?.dispose();
		this.binarySync = null;
		this.convex.dispose();
	}

	async loadSettings() {
		this.settings = normalizeLoadedSettings(await this.loadData());
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
			getClient: this.getConvexHttpClient,
			markSecretDeployedToUrl: async url => {
				this.settings.convexSecretDeployedToUrl = url;
				await this.saveSettings();
			},
		});
	}
}
