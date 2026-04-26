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
import {
	pullDotObsidianConfig,
	pushDotObsidianConfig,
} from "./file-sync/config-sync";
import {
	startObsidianLiveSync,
	type LiveSyncController,
} from "./obsidian/live-sync";
import { ResetLocalSyncStateModal } from "./obsidian/reset-local-sync-modal";
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
import { resetLocalSyncState } from "./storage/reset-local-sync-state";

export default class ObsidianConvexSyncPlugin extends Plugin {
	settings: MyPluginSettings = { ...DEFAULT_SETTINGS };
	private presenceSessionId = "";
	private convex = new ConvexClientManager(() => this.settings);
	private syncStatusBarItemEl: HTMLElement | null = null;
	private liveSync: LiveSyncController | null = null;
	private bulkSyncDepth = 0;

	getPresenceSessionId(): string {
		return this.presenceSessionId;
	}

	getConvexHttpClient = () => this.convex.getHttp();
	getConvexRealtimeClient = () => this.convex.getRealtime();
	getKeepaliveHttpClient = () => this.convex.getKeepaliveHttp();

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
		this.syncStatusBarItemEl = this.addStatusBarItem();
		this.syncStatusBarItemEl.setText("Convex sync: idle");
		await this.reloadLiveSync();

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
				this.beginBulkSync();
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
					})
					.finally(() => {
						this.endBulkSync();
					});
			},
		});
		this.addCommand({
			id: "push-obsidian-config",
			name: "Push .obsidian config to Convex",
			callback: () => {
				void this.pushObsidianConfig();
			},
		});
		this.addCommand({
			id: "pull-obsidian-config",
			name: "Pull .obsidian config from Convex",
			callback: () => {
				void this.pullObsidianConfig();
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
		this.addCommand({
			id: "reload-live-sync",
			name: "Reload live sync",
			callback: () => {
				void this.reloadLiveSync();
			},
		});
		this.addCommand({
			id: "reset-local-sync-state",
			name: "Reset local Convex sync state",
			callback: () => {
				const modal = new ResetLocalSyncStateModal(this.app);
				modal.onConfirm = () => {
					void this.resetLocalSyncState();
				};
				modal.open();
			},
		});

		this.addSettingTab(new ConvexSyncSettingTab(this.app, this));

	}

	onunload() {
		void leaveClientsPresence(this);
		void this.liveSync?.dispose();
		this.convex.dispose();
	}

	async loadSettings() {
		this.settings = normalizeLoadedSettings(await this.loadData());
	}

	/** Delegates to {@link mintVaultApiSecretFromConvexSite} for settings UI. */
	async mintVaultSecretFromDeployment(): Promise<boolean> {
		const minted = await mintVaultApiSecretFromConvexSite({
			settings: this.settings,
			saveSettings: () => this.saveSettings(),
			ensureRegistered: () =>
				this.ensureConvexSecretRegisteredWithDeployment(),
		});
		if (minted) {
			await this.reloadLiveSync();
		}
		return minted;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async reloadLiveSync(): Promise<void> {
		await this.liveSync?.dispose();
		this.liveSync = null;
		if (!this.convex.isConfigured()) {
			this.syncStatusBarItemEl?.setText("Convex sync: not configured");
			return;
		}
		this.liveSync = startObsidianLiveSync({
			app: this.app,
			settings: this.settings,
			getRealtimeClient: () => this.getConvexRealtimeClient(),
			getFileSyncClient: () => this.getConvexHttpClient(),
			getPresenceSessionId: () => this.getPresenceSessionId(),
			setStatus: (text) => this.syncStatusBarItemEl?.setText(text),
		});
		this.liveSync.setBulkSyncActive(this.bulkSyncDepth > 0);
	}

	private beginBulkSync(): void {
		this.bulkSyncDepth += 1;
		this.liveSync?.setBulkSyncActive(true);
	}

	private endBulkSync(): void {
		this.bulkSyncDepth = Math.max(0, this.bulkSyncDepth - 1);
		this.liveSync?.setBulkSyncActive(this.bulkSyncDepth > 0);
	}

	private async resetLocalSyncState(): Promise<void> {
		this.syncStatusBarItemEl?.setText("Convex sync: resetting local state...");
		try {
			await this.liveSync?.dispose();
			this.liveSync = null;
			const result = await resetLocalSyncState(this.app.vault.getName());
			console.info("[plugin] local sync state reset", {
				databaseNames: result.databaseNames,
			});
			new Notice("Convex sync: local sync state reset. Restarting live sync.", 8000);
			await this.reloadLiveSync();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.syncStatusBarItemEl?.setText("Convex sync: reset failed");
			new Notice(`Convex sync reset failed: ${message}`, 10000);
			console.error(error);
			await this.reloadLiveSync().catch((reloadError: unknown) => {
				console.error(reloadError);
			});
		}
	}

	async pushObsidianConfig(): Promise<void> {
		this.syncStatusBarItemEl?.setText("Convex sync: pushing .obsidian...");
		try {
			const result = await pushDotObsidianConfig({
				app: this.app,
				settings: this.settings,
				getConvexHttpClient: this.getConvexHttpClient,
				getPresenceSessionId: this.getPresenceSessionId.bind(this),
			});
			this.syncStatusBarItemEl?.setText(
				`Convex sync: pushed .obsidian (${result.filesUploaded} files)`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.syncStatusBarItemEl?.setText("Convex sync: .obsidian push failed");
			new Notice(`Convex .obsidian push failed: ${message}`, 10000);
			console.error(error);
		}
	}

	async pullObsidianConfig(): Promise<void> {
		this.syncStatusBarItemEl?.setText("Convex sync: pulling .obsidian...");
		try {
			const result = await pullDotObsidianConfig({
				app: this.app,
				settings: this.settings,
				getConvexHttpClient: this.getConvexHttpClient,
				getPresenceSessionId: this.getPresenceSessionId.bind(this),
			});
			this.syncStatusBarItemEl?.setText(
				`Convex sync: pulled .obsidian (${result.filesDownloaded} files)`,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.syncStatusBarItemEl?.setText("Convex sync: .obsidian pull failed");
			new Notice(`Convex .obsidian pull failed: ${message}`, 10000);
			console.error(error);
		}
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
