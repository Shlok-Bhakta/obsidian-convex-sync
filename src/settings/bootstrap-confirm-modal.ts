import { Modal } from "obsidian";

export class BootstrapConfirmModal extends Modal {
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
