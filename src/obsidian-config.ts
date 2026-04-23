import { normalizePath } from "obsidian";
import { matchesSyncIgnorePath } from "./sync-ignore";

type App = import("obsidian").App;

export type TrackedObsidianFile = {
	path: string;
	updatedAtMs: number;
};

export const OBSIDIAN_ROOT = ".obsidian";

export function isObsidianPath(path: string): boolean {
	const normalized = normalizePath(path);
	return normalized === OBSIDIAN_ROOT || normalized.startsWith(`${OBSIDIAN_ROOT}/`);
}

export function shouldTrackObsidianPath(path: string, ignorePaths: string[] = []): boolean {
	const normalized = normalizePath(path);
	if (!isObsidianPath(normalized)) {
		return false;
	}
	return !matchesSyncIgnorePath(normalized, ignorePaths);
}

export function folderPathForFile(filePath: string): string | null {
	const slash = filePath.lastIndexOf("/");
	if (slash < 0) {
		return null;
	}
	return filePath.slice(0, slash);
}

export async function ensureAdapterFolderExists(app: App, path: string): Promise<void> {
	const normalized = normalizePath(path);
	if (!normalized) {
		return;
	}
	const exists = await app.vault.adapter.exists(normalized);
	if (exists) {
		return;
	}
	const parent = folderPathForFile(normalized);
	if (parent) {
		await ensureAdapterFolderExists(app, parent);
	}
	await app.vault.adapter.mkdir(normalized);
}

export async function collectTrackedObsidianState(
	app: App,
	ignorePaths: string[] = [],
): Promise<{
	files: TrackedObsidianFile[];
	emptyFolders: string[];
}> {
	const rootExists = await app.vault.adapter.exists(OBSIDIAN_ROOT);
	if (!rootExists) {
		return { files: [], emptyFolders: [] };
	}
	const files: TrackedObsidianFile[] = [];
	const emptyFolders: string[] = [];
	const queue: string[] = [OBSIDIAN_ROOT];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}
		const listed = await app.vault.adapter.list(current);
		if (
			current !== OBSIDIAN_ROOT &&
			shouldTrackObsidianPath(current, ignorePaths) &&
			listed.files.length === 0 &&
			listed.folders.length === 0
		) {
			emptyFolders.push(normalizePath(current));
		}
		for (const filePath of listed.files) {
			const normalized = normalizePath(filePath);
			if (!shouldTrackObsidianPath(normalized, ignorePaths)) {
				continue;
			}
			const stat = await app.vault.adapter.stat(normalized);
			if (!stat || stat.type !== "file") {
				continue;
			}
			files.push({
				path: normalized,
				updatedAtMs: stat.mtime,
			});
		}
		for (const folderPath of listed.folders) {
			const normalized = normalizePath(folderPath);
			if (
				normalized === OBSIDIAN_ROOT ||
				shouldTrackObsidianPath(normalized, ignorePaths)
			) {
				queue.push(normalized);
			}
		}
	}
	return { files, emptyFolders };
}
