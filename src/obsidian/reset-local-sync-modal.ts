import { Modal } from "obsidian";

export class ResetLocalSyncStateModal extends Modal {
	onConfirm: (() => void) | null = null;

	onOpen(): void {
		this.contentEl.empty();
		this.titleEl.setText("Reset local Convex sync state");
		this.contentEl.createEl("p", {
			text: "This deletes this device's local IndexedDB sync cache for the current vault.",
		});
		this.contentEl.createEl("p", {
			text: "Vault files and Convex data are not deleted. The plugin will forget local path mappings, client identity, pending sync work, and cached Automerge documents, then rebuild sync state.",
		});
		this.contentEl.createEl("p", {
			text: "Use this only if sync state on this device seems corrupted or stuck.",
		});

		const row = this.contentEl.createDiv();
		row.style.display = "flex";
		row.style.gap = "8px";

		const confirmButton = row.createEl("button", {
			text: "Reset local sync state",
		});
		confirmButton.addClass("mod-warning");
		confirmButton.addEventListener("click", () => {
			this.close();
			this.onConfirm?.();
		});

		row.createEl("button", { text: "Cancel" }).addEventListener("click", () => {
			this.close();
		});
	}
}
