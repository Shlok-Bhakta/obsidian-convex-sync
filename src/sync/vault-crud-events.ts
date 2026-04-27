import { normalizePath, TFile, TFolder, type App, type EventRef } from "obsidian";
import { isTextSyncFile } from "../file-sync";
import type { BinarySyncManager } from "./binary-sync-manager";
import type { DocManager } from "./doc-manager";

type VaultCrudEventDeps = {
	registerEvent: (eventRef: EventRef) => void;
	vault: App["vault"];
	getDocManager: () => DocManager | null;
	getBinarySync: () => BinarySyncManager | null;
};

export function registerVaultCrudEventHandlers(deps: VaultCrudEventDeps): void {
	deps.registerEvent(
		deps.vault.on("create", (abstractFile) => {
			if (abstractFile instanceof TFile) {
				if (abstractFile.extension === "md") {
					void deps.getDocManager()?.onFileCreated(abstractFile.path);
				} else {
					void deps.getBinarySync()?.onLocalFileCreated(abstractFile);
				}
			} else if (abstractFile instanceof TFolder) {
				void deps.getBinarySync()?.onLocalFolderCreated(abstractFile.path);
			}
		}),
	);
	deps.registerEvent(
		deps.vault.on("modify", (abstractFile) => {
			if (abstractFile instanceof TFile) {
				const path = normalizePath(abstractFile.path);
				if (!isTextSyncFile(path)) {
					void deps.getBinarySync()?.onLocalFileModified(abstractFile);
				}
			}
		}),
	);
	deps.registerEvent(
		deps.vault.on("rename", (abstractFile, oldPath) => {
			if (abstractFile instanceof TFile) {
				if (abstractFile.extension === "md") {
					void deps.getDocManager()?.onFileRenamed(oldPath, abstractFile.path);
				} else {
					void deps.getBinarySync()?.onLocalFileRenamed(oldPath, abstractFile);
				}
			} else if (abstractFile instanceof TFolder) {
				void deps.getBinarySync()?.onLocalFolderRenamed(oldPath, abstractFile.path);
			}
		}),
	);
	deps.registerEvent(
		deps.vault.on("delete", (abstractFile) => {
			if (abstractFile instanceof TFile) {
				if (abstractFile.extension === "md") {
					void deps.getDocManager()?.onFileDeleted(abstractFile.path);
				} else {
					void deps.getBinarySync()?.onLocalFileDeleted(abstractFile.path);
				}
			} else if (abstractFile instanceof TFolder) {
				void deps.getBinarySync()?.onLocalFolderDeleted(abstractFile.path);
			}
		}),
	);
}
