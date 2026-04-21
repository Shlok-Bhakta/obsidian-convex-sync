import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ObsidianConvexSyncPlugin from "../main";

export class ConvexSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: ObsidianConvexSyncPlugin) {
		super(app, plugin);
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
	}
}
