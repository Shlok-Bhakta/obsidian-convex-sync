import {
	App,
	type EventRef,
	Modal,
	Notice,
	Plugin,
	Setting,
	TFile,
	TFolder,
	WorkspaceLeaf,
	normalizePath,
} from "obsidian";
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
import { registerVaultCrudEventHandlers } from "./sync/vault-crud-events";
import { YjsLocalCache } from "./sync/yjs-local-cache";

const DANGEROUS_RESET_PHRASE = "DELETE EVERYTHING";

class VaultResetConfirmModal extends Modal {
	onConfirm: (() => void) | null = null;
	private readonly confirmPhrase = DANGEROUS_RESET_PHRASE;
	private typedPhrase = "";

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.empty();
		this.titleEl.setText("Danger zone: wipe local vault and cache");
		this.contentEl.createEl("p", {
			text: "This command permanently deletes every file and folder in this vault, then clears local plugin IndexedDB/cache state.",
		});
		this.contentEl.createEl("p", {
			text: `Type "${this.confirmPhrase}" to enable the wipe button.`,
		});
		let wipeButton: HTMLButtonElement | null = null;
		new Setting(this.contentEl).setName("Confirmation").addText((text) => {
			text.setPlaceholder(this.confirmPhrase).onChange((value) => {
				this.typedPhrase = value.trim();
				wipeButton?.toggleAttribute("disabled", this.typedPhrase !== this.confirmPhrase);
			});
		});
		const row = this.contentEl.createDiv();
		row.style.display = "flex";
		row.style.gap = "8px";
		wipeButton = row.createEl("button", {
			text: "Wipe vault and local state",
		});
		wipeButton.style.backgroundColor = "var(--color-red)";
		wipeButton.style.color = "var(--text-on-accent)";
		wipeButton.setAttribute("disabled", "true");
		wipeButton.addEventListener("click", () => {
			if (this.typedPhrase !== this.confirmPhrase) return;
			this.close();
			this.onConfirm?.();
		});
		row.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.close();
		});
	}
}

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
		this.addCommand({
			id: "danger-reset-local-state",
			name: "Danger: reset local vault + IndexedDB state",
			callback: () => {
				const modal = new VaultResetConfirmModal(this.app);
				modal.onConfirm = () => {
					void this.resetLocalStateAndVault();
				};
				modal.open();
			},
		});

		this.syncStatusBarItemEl = this.addStatusBarItem();
		this.syncStatusBarItemEl.setText("Convex sync: idle");
		this.addSettingTab(new ConvexSyncSettingTab(this.app, this));

		registerVaultCrudEventHandlers({
			registerEvent: (eventRef: EventRef) => this.registerEvent(eventRef),
			vault: this.app.vault,
			getDocManager: () => this.docManager,
			getBinarySync: () => this.binarySync,
		});

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
					const textPaths = snapshot.files
						.filter((f: { isText: boolean }) => f.isText)
						.map((f: { path: string }) => f.path);
					void this.docManager?.warmUpAllDocs(textPaths).catch((e: unknown) => {
						console.warn("DocManager warmUp error", e);
					});
				} catch (e: unknown) {
					console.warn("DocManager warmUp snapshot error", e);
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

	private async resetLocalStateAndVault(): Promise<void> {
		this.syncStatusBarItemEl?.setText("Convex sync: local reset in progress...");
		try {
			await this.docManager?.closeCurrentDoc();
			this.binarySync?.dispose();
			this.binarySync = null;

			const all = this.app.vault.getAllLoadedFiles();
			const files = all.filter((entry): entry is TFile => entry instanceof TFile);
			const folders = all
				.filter((entry): entry is TFolder => entry instanceof TFolder && entry.path !== "")
				.sort((a, b) => b.path.length - a.path.length);

			for (const file of files) {
				await this.app.vault.delete(file, true).catch(() => {});
			}
			for (const folder of folders) {
				await this.app.vault.delete(folder, true).catch(() => {});
			}

			await YjsLocalCache.clearAll();
			await deleteIndexedDbDatabase("obsidian-yjs-v1");
			this.settings = { ...DEFAULT_SETTINGS };
			await this.saveSettings();
			new Notice("Local vault files and IndexedDB cache were wiped.", 8000);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Local reset failed: ${message}`, 12000);
			console.error("Local reset failed", error);
		} finally {
			this.syncStatusBarItemEl?.setText("Convex sync: idle");
		}
	}
}

async function deleteIndexedDbDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error ?? new Error(`Failed to delete IndexedDB ${name}`));
		request.onblocked = () => reject(new Error(`IndexedDB ${name} deletion blocked by an open connection`));
	});
}
