import { normalizePath, TFile, TFolder, type App, type EventRef } from "obsidian";
import { isTextSyncFile } from "../file-sync";
import type { BinarySyncManager } from "./binary-sync-manager";
import type { DocManager } from "./doc-manager";

type VaultCrudEventDeps = {
	registerEvent: (eventRef: EventRef) => void;
	vault: App["vault"];
	getActiveFile: () => TFile | null;
	getDocManager: () => DocManager | null;
	getBinarySync: () => BinarySyncManager | null;
};

export function registerVaultCrudEventHandlers(deps: VaultCrudEventDeps): void {
	deps.registerEvent(
		deps.vault.on("create", (abstractFile) => {
			if (abstractFile instanceof TFile) {
				if (abstractFile.extension === "md") {
					void (async () => {
						const docManager = deps.getDocManager();
						await docManager?.onFileCreated(abstractFile.path);
						// Some note-creation flows may not emit a reliable file-open event.
						// If the created note is already active, bind Yjs immediately.
						const activeFile = deps.getActiveFile();
						if (activeFile?.path === abstractFile.path) {
							await docManager?.onFileOpen(abstractFile.path);
						}
					})();
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
				if (isTextSyncFile(path)) {
					void deps.getDocManager()?.onFileModified(path);
				} else {
					void deps.getBinarySync()?.onLocalFileModified(abstractFile);
				}
			}
		}),
	);
	deps.registerEvent(
		deps.vault.on("rename", (abstractFile, oldPath) => {
			if (abstractFile instanceof TFile) {
				if (abstractFile.extension === "md") {
					deps.getBinarySync()?.noteLocalDeletePending(normalizePath(oldPath));
					void (async () => {
						const docManager = deps.getDocManager();
						await docManager?.onFileRenamed(oldPath, abstractFile.path);
						// Name-edit rename may leave the file active without a follow-up file-open.
						// Ensure the renamed active note is immediately bound for live sync.
						const activeFile = deps.getActiveFile();
						if (activeFile?.path === abstractFile.path) {
							await docManager?.onFileOpen(abstractFile.path);
						}
					})();
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
					deps.getBinarySync()?.noteLocalDeletePending(normalizePath(abstractFile.path));
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
