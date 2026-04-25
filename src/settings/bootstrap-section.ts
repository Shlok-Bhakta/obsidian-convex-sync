import { Notice, Setting } from "obsidian";
import type { BootstrapUiState } from "../bootstrap/service";

function formatBytes(value: number): string {
	if (value < 1024) {
		return `${value} B`;
	}
	if (value < 1024 * 1024) {
		return `${(value / 1024).toFixed(1)} KB`;
	}
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function renderBootstrapSection(options: {
	containerEl: HTMLElement;
	state: BootstrapUiState;
	onGenerate(): void;
	onCopyUrl(url: string): Promise<void>;
	onCancelLink(): Promise<void>;
}): void {
	const { containerEl, state } = options;
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
				options.onGenerate();
			}),
		);

	if (state.kind === "syncing" || state.kind === "building") {
		const phase =
			state.kind === "syncing"
				? `Syncing: ${state.phase}`
				: `Building: ${state.phase}`;
		containerEl.createEl("p", { text: phase });
		const progressEl = containerEl.createEl("progress");
		const completed =
			state.kind === "syncing" ? state.completed : state.filesProcessed;
		const total = state.kind === "syncing" ? state.total : state.filesTotal;
		progressEl.max = Math.max(total, 1);
		progressEl.value = Math.min(completed, progressEl.max);
		if (state.kind === "building") {
			containerEl.createEl("p", {
				text: `${formatBytes(state.bytesProcessed)} / ${formatBytes(state.bytesTotal)}`,
			});
		}
	}

	if (state.kind === "ready") {
		const remainingMs = Math.max(0, state.expiresAtMs - Date.now());
		const minutes = Math.floor(remainingMs / 60_000);
		const seconds = Math.floor((remainingMs % 60_000) / 1000)
			.toString()
			.padStart(2, "0");
		containerEl.createEl("p", {
			text: `Link expires in ${minutes}:${seconds}. Archive size: ${formatBytes(state.sizeBytes)}.`,
		});
		new Setting(containerEl)
			.setName("Download URL")
			.addText((text) => text.setValue(state.url).setDisabled(true))
			.addButton((button) =>
				button.setButtonText("Copy").onClick(async () => {
					await options.onCopyUrl(state.url);
				}),
			);
		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Cancel link now").onClick(async () => {
				await options.onCancelLink();
			}),
		);
	}

	if (state.kind === "failed") {
		containerEl.createEl("p", {
			text: `Bootstrap failed: ${state.message}`,
		});
	}
	if (state.kind === "expired") {
		containerEl.createEl("p", { text: "Bootstrap link expired." });
	}
}

export async function copyBootstrapUrl(url: string): Promise<void> {
	await navigator.clipboard.writeText(url);
	new Notice("Bootstrap link copied.");
}
