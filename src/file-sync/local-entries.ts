import { TFile, TFolder, normalizePath, type App } from "obsidian";
import {
	ensureAdapterFolderExists,
} from "../lib/obsidian-vault";
import { folderPathForFile } from "../lib/path";
import {
	OBSIDIAN_ROOT,
	shouldIgnoreVaultPath,
} from "./path-rules";
import type {
	FileSyncHost,
	LocalEntriesState,
	LocalFileEntry,
} from "./types";

function listEmptyFolders(app: App): string[] {
	const all = app.vault.getAllLoadedFiles();
	const empty: string[] = [];
	for (const entry of all) {
		if (!(entry instanceof TFolder)) {
			continue;
		}
		if (entry.path.trim() === "") {
			continue;
		}
		if (shouldIgnoreVaultPath(normalizePath(entry.path))) {
			continue;
		}
		if (entry.children.length === 0) {
			empty.push(normalizePath(entry.path));
		}
	}
	return empty;
}

async function listDotObsidianEntries(
	host: FileSyncHost,
): Promise<LocalEntriesState> {
	const rootExists = await host.app.vault.adapter.exists(OBSIDIAN_ROOT);
	if (!rootExists) {
		return { files: [], emptyFolders: [] };
	}
	const files: LocalFileEntry[] = [];
	const emptyFolders: string[] = [];
	const queue: string[] = [OBSIDIAN_ROOT];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || shouldIgnoreVaultPath(current)) {
			continue;
		}
		const listed = await host.app.vault.adapter.list(current);
		const syncedFiles = listed.files.filter((filePath) => !shouldIgnoreVaultPath(filePath));
		const syncedFolders = listed.folders.filter(
			(folderPath) => !shouldIgnoreVaultPath(folderPath),
		);
		if (syncedFiles.length === 0 && syncedFolders.length === 0) {
			emptyFolders.push(normalizePath(current));
		}
		for (const filePath of syncedFiles) {
			const normalized = normalizePath(filePath);
			const stat = await host.app.vault.adapter.stat(normalized);
			if (!stat || stat.type !== "file") {
				continue;
			}
			files.push({
				path: normalized,
				updatedAtMs: stat.mtime,
				readBytes: () => host.app.vault.adapter.readBinary(normalized),
				writeBytes: (bytes) => host.app.vault.adapter.writeBinary(normalized, bytes),
				createBytes: async (bytes) => {
					await ensureAdapterFolderExists(
						host.app,
						folderPathForFile(normalized),
					);
					await host.app.vault.adapter.writeBinary(normalized, bytes);
				},
			});
		}
		for (const folderPath of syncedFolders) {
			queue.push(normalizePath(folderPath));
		}
	}
	return { files, emptyFolders };
}

export async function listLocalEntries(
	host: FileSyncHost,
): Promise<LocalEntriesState> {
	const fromVault = host.app.vault
		.getAllLoadedFiles()
		.filter((entry): entry is TFile => entry instanceof TFile)
		.filter((file) => !shouldIgnoreVaultPath(normalizePath(file.path)))
		.map<LocalFileEntry>((file) => ({
			path: normalizePath(file.path),
			updatedAtMs: file.stat.mtime,
			readBytes: () => host.app.vault.readBinary(file),
			writeBytes: (bytes) => host.app.vault.modifyBinary(file, bytes),
			createBytes: (bytes) => host.app.vault.createBinary(file.path, bytes).then(() => {}),
		}));

	const byPath = new Map<string, LocalFileEntry>();
	for (const entry of fromVault) {
		byPath.set(entry.path, entry);
	}
	const dotObsidian = await listDotObsidianEntries(host);
	for (const entry of dotObsidian.files) {
		byPath.set(entry.path, entry);
	}

	return {
		files: [...byPath.values()],
		emptyFolders: [...listEmptyFolders(host.app), ...dotObsidian.emptyFolders],
	};
}
