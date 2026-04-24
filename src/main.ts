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
import { startLiveSync } from "./live-sync";
import {
	ensureVaultSecretRegisteredWithDeployment,
	mintVaultApiSecretFromConvexSite,
} from "./security";
import {
	clearSyncDebugEvents,
	getSyncDebugReport,
	recordSyncDebugEvent,
} from "./sync/debug";
import {
	normalizeLoadedSettings,
	DEFAULT_SETTINGS,
	ConvexSyncSettingTab,
	type MyPluginSettings,
} from "./settings";

export default class ObsidianConvexSyncPlugin extends Plugin {
	settings: MyPluginSettings = { ...DEFAULT_SETTINGS };
	private presenceSessionId = "";
	private convex = new ConvexClientManager(() => this.settings);
	private syncStatusBarItemEl: HTMLElement | null = null;
	private stopLiveSync: (() => void) | null = null;

	getPresenceSessionId = (): string => this.presenceSessionId;
	getConvexHttpClient = () => this.convex.getHttp();
	getConvexRealtimeClient = () => this.convex.getRealtime();
	getKeepaliveHttpClient = () => this.convex.getKeepaliveHttp();
	setSyncStatus = (text: string) => {
		this.syncStatusBarItemEl?.setText(text);
	};
	recordSyncDebug = (area: string, message: string, data?: Record<string, unknown>) => {
		recordSyncDebugEvent(this.settings, area, message, data);
	};

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
			name: "Reconcile vault files with Convex",
			callback: () => {
				this.recordSyncDebug("command", "manual full sync started");
				this.syncStatusBarItemEl?.setText("Convex sync: starting...");
				void runVaultFileSync({
					app: this.app,
					settings: this.settings,
					getConvexHttpClient: () => this.getConvexHttpClient(),
					getPresenceSessionId: () => this.getPresenceSessionId(),
					recordSyncDebug: this.recordSyncDebug,
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
			id: "copy-sync-debug-report",
			name: "Copy sync debug report",
			callback: () => {
				void navigator.clipboard.writeText(getSyncDebugReport(this.app, this.settings))
					.then(() => new Notice("Convex sync debug report copied."))
					.catch((error: unknown) => {
						console.error(error);
						new Notice("Convex sync: failed to copy debug report. Check the console.", 8000);
					});
			},
		});
		this.addCommand({
			id: "clear-sync-debug-log",
			name: "Clear sync debug log",
			callback: () => {
				clearSyncDebugEvents();
				new Notice("Convex sync debug log cleared.");
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
		await this.reloadLiveSync();
	}

	onunload() {
		this.stopLiveSync?.();
		this.stopLiveSync = null;
		void leaveClientsPresence(this);
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

	async reloadLiveSync(): Promise<void> {
		this.stopLiveSync?.();
		this.stopLiveSync = null;
		if (!this.settings.enableLiveSync) {
			this.recordSyncDebug("live", "live sync disabled");
			this.syncStatusBarItemEl?.setText("Convex sync: live sync disabled");
			return;
		}
		this.recordSyncDebug("live", "live sync starting");
		this.stopLiveSync = startLiveSync(this);
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
