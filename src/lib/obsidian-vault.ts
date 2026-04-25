import {
	normalizePath,
	TFile,
	TFolder,
	type App,
} from "obsidian";
import { folderPathForFile } from "./path";

export async function ensureVaultFolderExists(
	app: App,
	path: string | null,
): Promise<void> {
	const normalized = normalizePath(path ?? "");
	if (!normalized) {
		return;
	}
	const existing = app.vault.getAbstractFileByPath(normalized);
	if (existing instanceof TFolder) {
		return;
	}
	await ensureVaultFolderExists(app, folderPathForFile(normalized));
	await app.vault.createFolder(normalized);
}

export async function ensureAdapterFolderExists(
	app: App,
	path: string | null,
): Promise<void> {
	const normalized = normalizePath(path ?? "");
	if (!normalized) {
		return;
	}
	const exists = await app.vault.adapter.exists(normalized);
	if (exists) {
		return;
	}
	await ensureAdapterFolderExists(app, folderPathForFile(normalized));
	await app.vault.adapter.mkdir(normalized);
}

export function isTextSyncFile(file: TFile): boolean {
	const extension = file.extension.toLowerCase();
	return extension === "md" || extension === "markdown" || extension === "txt";
}
