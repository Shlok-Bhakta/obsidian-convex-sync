import {
	normalizePath,
	TFile,
	TFolder,
	type App,
} from "obsidian";
import { isMergeBackupPath } from "./merge-backups";
import { folderPathForFile } from "./path";

async function rethrowUnlessVaultFolderExists(
	app: App,
	path: string,
	error: unknown,
): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) {
		return;
	}
	const stat = await app.vault.adapter.stat(path);
	if (stat?.type === "folder") {
		return;
	}
	throw error;
}

async function rethrowUnlessAdapterFolderExists(
	app: App,
	path: string,
	error: unknown,
): Promise<void> {
	const stat = await app.vault.adapter.stat(path);
	if (stat?.type === "folder") {
		return;
	}
	throw error;
}

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
	try {
		await app.vault.createFolder(normalized);
	} catch (error) {
		await rethrowUnlessVaultFolderExists(app, normalized, error);
	}
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
	try {
		await app.vault.adapter.mkdir(normalized);
	} catch (error) {
		await rethrowUnlessAdapterFolderExists(app, normalized, error);
	}
}

export function isTextSyncFile(file: TFile): boolean {
	const extension = file.extension.toLowerCase();
	return (
		(extension === "md" || extension === "markdown" || extension === "txt") &&
		!isMergeBackupPath(file.path)
	);
}
