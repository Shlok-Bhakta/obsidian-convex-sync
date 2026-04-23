import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsidianConvexSyncPlugin from "../main";
import { DEFAULT_SYNC_IGNORE_PATHS, normalizeSyncIgnorePaths } from "../sync-ignore";
import {
	cancelBootstrap,
	readBootstrapStatus,
	startBootstrapBuild,
	type BootstrapUiState,
} from "../bootstrap/service";

function formatBytes(value: number): string {
	if (value < 1024) {
		return `${value} B`;
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KB`;
	}
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

class BootstrapConfirmModal extends Modal {
	onConfirm: (() => void) | null = null;

	onOpen(): void {
		this.contentEl.empty();
		this.titleEl.setText("Generate bootstrap download link");
		this.contentEl.createEl("p", {
			text: "Do not edit files on this device until the new device has extracted the bootstrap zip and opened the vault.",
		});
		this.contentEl.createEl("p", {
			text: "The bootstrap is a point-in-time snapshot. Edits during setup can be lost or create conflicts.",
		});
		const row = this.contentEl.createDiv();
		row.style.display = "flex";
		row.style.gap = "8px";
		const confirmButton = row.createEl("button", {
			text: "I won't touch files - generate",
		});
		confirmButton.addEventListener("click", () => {
			this.close();
			this.onConfirm?.();
		});
		row.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.close();
		});
	}
}

export class ConvexSyncSettingTab extends PluginSettingTab {
	private bootstrapState: BootstrapUiState = { kind: "idle" };
	private bootstrapPollingInterval: number | null = null;
	private bootstrapCountdownInterval: number | null = null;
	private hasHydratedBootstrapState = false;

	constructor(app: App, private readonly plugin: ObsidianConvexSyncPlugin) {
		super(app, plugin);
		this.plugin.register(() => this.stopBootstrapIntervals());
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Convex URL")
			.setDesc("Deployment URL (CONVEX_URL).")
			.addText((text) =>
				text
					.setPlaceholder("http://...")
					.setValue(this.plugin.settings.convexUrl)
					.onChange(async (value) => {
						this.plugin.settings.convexUrl = value;
						await this.plugin.saveSettings();
						await this.plugin.ensureConvexSecretRegisteredWithDeployment();
					}),
			);

		new Setting(containerEl)
			.setName("Convex site URL")
			.setDesc(
				"Site URL for HTTP routes (CONVEX_SITE_URL). Required before you can mint a vault API key below.",
			)
			.addText((text) =>
				text
					.setPlaceholder("http://...")
					.setValue(this.plugin.settings.convexSiteUrl)
					.onChange(async (value) => {
						this.plugin.settings.convexSiteUrl = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		const canMint =
			this.plugin.settings.convexSiteUrl.trim() !== "" &&
			this.plugin.settings.convexSecret.trim() === "";

		new Setting(containerEl)
			.setName("Mint vault API key")
			.setDesc(
				"Request a one-time server-generated key from your Convex deployment. Set Convex site URL first. If this deployment already has a key, mint is denied; use the original vault or clear pluginAuth in the Convex dashboard.",
			)
			.addButton((button) =>
				button
					.setButtonText("Mint from Convex")
					.setTooltip(
						canMint
							? "Call the deployment HTTP mint endpoint once"
							: "Set site URL and ensure no key is stored yet",
					)
					.setDisabled(!canMint)
					.onClick(async () => {
						button.setDisabled(true);
						try {
							await this.plugin.mintVaultSecretFromDeployment();
						} catch (err) {
							console.error(err);
							new Notice(
								"Convex: mint failed unexpectedly. Check the console.",
								10000,
							);
						}
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Convex secret")
			.setDesc(
				"Shared secret sent to Convex (CONVEX_SECRET). Mint it with the button above; keep it private.",
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.convexSecret).setDisabled(true);
			});

		new Setting(containerEl)
			.setName("Enable live sync")
			.setDesc(
				"Use the new continuous sync engine for normal vault files. Turn this off to fall back to manual full sync.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.liveSyncEnabled).onChange(async (value) => {
					this.plugin.settings.liveSyncEnabled = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Binary version retention")
			.setDesc("How many historical binary versions to keep per file.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.binaryVersionRetention))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.binaryVersionRetention = Number.isFinite(parsed)
							? parsed
							: this.plugin.settings.binaryVersionRetention;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Trash retention (days)")
			.setDesc("How long deleted files stay in .trash before server GC removes them.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.trashRetentionDays))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.trashRetentionDays = Number.isFinite(parsed)
							? parsed
							: this.plugin.settings.trashRetentionDays;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Editor batch window (ms)")
			.setDesc("Debounce window for bundling local editor changes before sending ops.")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.editorKeystrokeBatchMs))
					.onChange(async (value) => {
						const parsed = Number(value);
						this.plugin.settings.editorKeystrokeBatchMs = Number.isFinite(parsed)
							? parsed
							: this.plugin.settings.editorKeystrokeBatchMs;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync ignore paths")
			.setDesc(
				`One path per line. Add a trailing / to ignore a whole folder. Defaults: ${DEFAULT_SYNC_IGNORE_PATHS.join(", ")}.`,
			)
			.addTextArea((text) => {
				text
					.setPlaceholder(".obsidian/cache/\n.obsidian/workspace.json")
					.setValue(this.plugin.settings.syncIgnorePaths.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.syncIgnorePaths = normalizeSyncIgnorePaths(
							value
								.split("\n")
								.map((line) => line.trim())
								.filter((line) => line !== ""),
						);
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 6;
				text.inputEl.style.width = "100%";
			});

		this.renderBootstrapSection(containerEl);
		if (!this.hasHydratedBootstrapState) {
			this.hasHydratedBootstrapState = true;
			void this.refreshBootstrapState();
		}
	}

	private stopBootstrapIntervals(): void {
		if (this.bootstrapPollingInterval !== null) {
			window.clearInterval(this.bootstrapPollingInterval);
			this.bootstrapPollingInterval = null;
		}
		if (this.bootstrapCountdownInterval !== null) {
			window.clearInterval(this.bootstrapCountdownInterval);
			this.bootstrapCountdownInterval = null;
		}
	}

	private stopBootstrapPolling(): void {
		if (this.bootstrapPollingInterval !== null) {
			window.clearInterval(this.bootstrapPollingInterval);
			this.bootstrapPollingInterval = null;
		}
	}

	private startBootstrapPolling(): void {
		if (this.bootstrapPollingInterval !== null) {
			return;
		}
		this.bootstrapPollingInterval = window.setInterval(() => {
			void this.refreshBootstrapState();
		}, 1000);
	}

	private startCountdownRefresh(): void {
		if (this.bootstrapCountdownInterval !== null) {
			return;
		}
		this.bootstrapCountdownInterval = window.setInterval(() => {
			if (this.bootstrapState.kind !== "ready") {
				this.stopBootstrapIntervals();
				return;
			}
			if (Date.now() >= this.bootstrapState.expiresAtMs) {
				this.bootstrapState = { kind: "expired", phase: "Expired" };
				this.display();
				return;
			}
			this.display();
		}, 1000);
	}

	private async refreshBootstrapState(): Promise<void> {
		if (!this.plugin.settings.convexSecret.trim()) {
			return;
		}
		try {
			this.bootstrapState = await readBootstrapStatus({
				app: this.app,
				settings: this.plugin.settings,
				getConvexHttpClient: this.plugin.getConvexHttpClient,
				getPresenceSessionId: this.plugin.getPresenceSessionId.bind(this.plugin),
			});
			if (this.bootstrapState.kind === "building") {
				this.startBootstrapPolling();
			}
			if (this.bootstrapState.kind === "ready") {
				this.stopBootstrapPolling();
				this.startCountdownRefresh();
			}
			if (
				this.bootstrapState.kind === "expired" ||
				this.bootstrapState.kind === "failed" ||
				this.bootstrapState.kind === "idle"
			) {
				this.stopBootstrapIntervals();
			}
			this.display();
		} catch (error) {
			console.error(error);
		}
	}

	private renderBootstrapSection(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Bootstrap new device" });
		const warning = containerEl.createDiv();
		warning.style.padding = "8px 10px";
		warning.style.border = "1px solid var(--color-orange)";
		warning.style.borderRadius = "6px";
		warning.style.marginBottom = "12px";
		warning.setText(
			"Important: while a bootstrap link is active, do not edit files on this device until the new device finishes extracting the zip and opens the vault.",
		);

		new Setting(containerEl)
			.setName("Generate bootstrap link (10 min)")
			.setDesc(
				"Creates a full vault snapshot from Convex, including .obsidian and plugin key data, and returns a temporary download link.",
			)
			.addButton((button) =>
				button.setButtonText("Generate link").onClick(() => {
					const modal = new BootstrapConfirmModal(this.app);
					modal.onConfirm = () => {
						void this.startBootstrapFlow();
					};
					modal.open();
				}),
			);

		if (this.bootstrapState.kind === "syncing" || this.bootstrapState.kind === "building") {
			const phase =
				this.bootstrapState.kind === "syncing"
					? `Syncing: ${this.bootstrapState.phase}`
					: `Building: ${this.bootstrapState.phase}`;
			containerEl.createEl("p", { text: phase });
			const progressEl = containerEl.createEl("progress");
			const completed =
				this.bootstrapState.kind === "syncing"
					? this.bootstrapState.completed
					: this.bootstrapState.filesProcessed;
			const total =
				this.bootstrapState.kind === "syncing"
					? this.bootstrapState.total
					: this.bootstrapState.filesTotal;
			progressEl.max = Math.max(total, 1);
			progressEl.value = Math.min(completed, progressEl.max);
			if (this.bootstrapState.kind === "building") {
				containerEl.createEl("p", {
					text: `${formatBytes(this.bootstrapState.bytesProcessed)} / ${formatBytes(this.bootstrapState.bytesTotal)}`,
				});
			}
		}

		if (this.bootstrapState.kind === "ready") {
			const readyState = this.bootstrapState;
			const remainingMs = Math.max(0, this.bootstrapState.expiresAtMs - Date.now());
			const minutes = Math.floor(remainingMs / 60_000);
			const seconds = Math.floor((remainingMs % 60_000) / 1000)
				.toString()
				.padStart(2, "0");
			containerEl.createEl("p", {
				text: `Link expires in ${minutes}:${seconds}. Archive size: ${formatBytes(this.bootstrapState.sizeBytes)}.`,
			});
			new Setting(containerEl)
				.setName("Download URL")
				.addText((text) => text.setValue(readyState.url).setDisabled(true))
				.addButton((button) =>
					button.setButtonText("Copy").onClick(async () => {
						await navigator.clipboard.writeText(readyState.url);
						new Notice("Bootstrap link copied.");
					}),
				);
			new Setting(containerEl).addButton((button) =>
				button.setButtonText("Cancel link now").onClick(async () => {
					await cancelBootstrap({
						app: this.app,
						settings: this.plugin.settings,
						getConvexHttpClient: this.plugin.getConvexHttpClient,
						getPresenceSessionId: this.plugin.getPresenceSessionId.bind(this.plugin),
					});
					this.bootstrapState = { kind: "expired", phase: "Cancelled" };
					this.display();
				}),
			);
		}

		if (this.bootstrapState.kind === "failed") {
			containerEl.createEl("p", {
				text: `Bootstrap failed: ${this.bootstrapState.message}`,
			});
		}
		if (this.bootstrapState.kind === "expired") {
			containerEl.createEl("p", { text: "Bootstrap link expired." });
		}
	}

	private async startBootstrapFlow(): Promise<void> {
		this.bootstrapState = {
			kind: "syncing",
			phase: "Syncing vault to Convex",
			completed: 0,
			total: 1,
		};
		this.display();
		try {
			await startBootstrapBuild(
				{
					app: this.app,
					settings: this.plugin.settings,
					getConvexHttpClient: this.plugin.getConvexHttpClient,
					getPresenceSessionId: this.plugin.getPresenceSessionId.bind(this.plugin),
					syncBeforeBootstrap: (onState) => this.plugin.syncVaultToConvex(onState),
				},
				(state) => {
					this.bootstrapState = state;
					this.display();
				},
			);
			this.startBootstrapPolling();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.bootstrapState = { kind: "failed", phase: "Failed", message };
			new Notice(`Bootstrap generation failed: ${message}`, 10000);
			this.display();
		}
	}
}
