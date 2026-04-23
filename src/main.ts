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
	ensureVaultSecretRegisteredWithDeployment,
	mintVaultApiSecretFromConvexSite,
} from "./security";
import {
	normalizeLoadedSettings,
	DEFAULT_SETTINGS,
	ConvexSyncSettingTab,
	type MyPluginSettings,
} from "./settings";
import { LiveSyncEngine } from "./sync";

export default class ObsidianConvexSyncPlugin extends Plugin {
	settings: MyPluginSettings = { ...DEFAULT_SETTINGS };
	private presenceSessionId = "";
	private convex = new ConvexClientManager(() => this.settings);
	private syncStatusBarItemEl: HTMLElement | null = null;
	private liveSyncEngine: LiveSyncEngine | null = null;

	getPresenceSessionId(): string {
		return this.presenceSessionId;
	}

	getConvexHttpClient = () => this.convex.getHttp();
	getConvexRealtimeClient = () => this.convex.getRealtime();
	getKeepaliveHttpClient = () => this.convex.getKeepaliveHttp();
	setSyncStatus = (message: string) => this.syncStatusBarItemEl?.setText(message);

	async onload() {
		await this.loadSettings();
		this.presenceSessionId = crypto.randomUUID();
		await this.ensureConvexSecretRegisteredWithDeployment();

		this.registerView(
			CLIENTS_PRESENCE_VIEW_TYPE,
			(leaf: WorkspaceLeaf) => new ClientsPresenceView(leaf, this),
		);

		this.syncStatusBarItemEl = this.addStatusBarItem();
		this.syncStatusBarItemEl.setText("Convex sync: idle");

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
				void this.syncVaultToConvex(({ phase, completed, total }) => {
					const percent = total <= 0 ? 0 : Math.min(100, Math.round((completed / total) * 100));
					this.syncStatusBarItemEl?.setText(
						`Convex sync: ${percent}% (${completed}/${total}) - ${phase}`,
					);
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

		this.addSettingTab(new ConvexSyncSettingTab(this.app, this));

		window.setTimeout(() => {
			void this.startLiveSyncEngine();
		}, 0);
	}

	onunload() {
		this.liveSyncEngine?.stop();
		this.liveSyncEngine = null;
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

	private async startLiveSyncEngine(): Promise<void> {
		try {
			this.liveSyncEngine = await LiveSyncEngine.create(this);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.setSyncStatus("Convex sync: failed");
			new Notice(`Convex live sync failed to start: ${message}`, 10000);
			console.error("Live sync engine failed to start", error);
		}
	}

	async syncVaultToConvex(
		reportSyncProgress?: (status: {
			phase: string;
			completed: number;
			total: number;
		}) => void,
	): Promise<void> {
		if (this.liveSyncEngine) {
			reportSyncProgress?.({
				phase: "Reconciling live sync state",
				completed: 0,
				total: 1,
			});
			await this.liveSyncEngine.syncNow({ pruneRemoteDeletions: true });
			reportSyncProgress?.({
				phase: "Live sync up to date",
				completed: 1,
				total: 1,
			});
			return;
		}
		await runVaultFileSync({
			app: this.app,
			settings: this.settings,
			getConvexHttpClient: () => this.getConvexHttpClient(),
			getPresenceSessionId: () => this.getPresenceSessionId(),
			reportSyncProgress,
		});
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
