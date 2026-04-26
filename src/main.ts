import { Notice, Plugin, TFile, TFolder, WorkspaceLeaf, normalizePath } from "obsidian";
import {
	ClientsPresenceView,
	CLIENTS_PRESENCE_VIEW_TYPE,
	leaveClientsPresence,
	revealClientsPresenceView,
	startClientsPresence,
} from "./clients-presence";
import { ConvexClientManager } from "./convex/client-manager";
import { isTextSyncFile, runVaultFileSync } from "./file-sync";
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

	/** Flush open Markdown Yjs state before bootstrap so the archive matches the editor. */
	async flushEditorDocForBootstrap(): Promise<void> {
		await this.docManager?.closeCurrentDoc();
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

			this.registerEvent(
				this.app.vault.on("create", (abstractFile) => {
					if (abstractFile instanceof TFile) {
						if (abstractFile.extension === "md") {
							void this.docManager?.onFileCreated(abstractFile.path);
						} else {
							void this.binarySync?.onLocalFileCreated(abstractFile);
						}
					} else if (abstractFile instanceof TFolder) {
						void this.binarySync?.onLocalFolderCreated(abstractFile.path);
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on("modify", (abstractFile) => {
					if (abstractFile instanceof TFile) {
						const path = normalizePath(abstractFile.path);
						if (!isTextSyncFile(path)) {
							void this.binarySync?.onLocalFileModified(abstractFile);
						}
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on("rename", (abstractFile, oldPath) => {
					if (abstractFile instanceof TFile) {
						if (abstractFile.extension === "md") {
							void this.docManager?.onFileRenamed(oldPath, abstractFile.path);
						} else {
							void this.binarySync?.onLocalFileRenamed(oldPath, abstractFile);
						}
					} else if (abstractFile instanceof TFolder) {
						void this.binarySync?.onLocalFolderRenamed(oldPath, abstractFile.path);
					}
				}),
			);
			this.registerEvent(
				this.app.vault.on("delete", (abstractFile) => {
					if (abstractFile instanceof TFile) {
						if (abstractFile.extension === "md") {
							void this.docManager?.onFileDeleted(abstractFile.path);
						} else {
							void this.binarySync?.onLocalFileDeleted(abstractFile.path);
						}
					} else if (abstractFile instanceof TFolder) {
						void this.binarySync?.onLocalFolderDeleted(abstractFile.path);
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
				this.presenceSessionId,
			);
			void (async () => {
				try {
					await this.binarySync?.start();
				} catch (err: unknown) {
					console.error("Convex binary sync catch-up failed", err);
				}
				const secret = this.settings.convexSecret.trim();
				if (!secret || !this.docManager) return;
				try {
					const snapshot = await this.getConvexHttpClient().query(api.fileSync.listSnapshot, {
						convexSecret: secret,
					});
					const textPaths = snapshot.files.filter((f) => f.isText).map((f) => f.path);
					await this.docManager.warmUpAllDocs(textPaths);
				} catch (e: unknown) {
					console.warn("DocManager warmUp error", e);
				}
			})();
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
