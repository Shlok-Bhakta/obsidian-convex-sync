import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsidianConvexSyncPlugin from "../main";
import {
	cancelBootstrap,
	readBootstrapStatus,
	startBootstrapBuild,
	type BootstrapUiState,
} from "../bootstrap/service";
import { BootstrapConfirmModal } from "./bootstrap-confirm-modal";
import {
	copyBootstrapUrl,
	renderBootstrapSection,
} from "./bootstrap-section";

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
						await this.plugin.reloadLiveSync();
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
			this.stopBootstrapIntervals();
			this.bootstrapState = { kind: "idle" };
			this.display();
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
		renderBootstrapSection({
			containerEl,
			state: this.bootstrapState,
			onGenerate: () => {
				const modal = new BootstrapConfirmModal(this.app);
				modal.onConfirm = () => {
					void this.startBootstrapFlow();
				};
				modal.open();
			},
			onCopyUrl: copyBootstrapUrl,
			onCancelLink: async () => {
				await cancelBootstrap({
					app: this.app,
					settings: this.plugin.settings,
					getConvexHttpClient: this.plugin.getConvexHttpClient,
					getPresenceSessionId: this.plugin.getPresenceSessionId.bind(this.plugin),
				});
				this.bootstrapState = { kind: "expired", phase: "Cancelled" };
				this.display();
			},
		});
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
