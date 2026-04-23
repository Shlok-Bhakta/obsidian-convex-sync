import { FileSystemAdapter, normalizePath } from "obsidian";
import { matchesSyncIgnorePath } from "./sync-ignore";

type App = import("obsidian").App;
type NodeFsPromises = typeof import("fs/promises");
type NodePath = typeof import("path");

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

async function collectTrackedObsidianFsState(
	app: App,
	ignorePaths: string[],
): Promise<{
	files: TrackedObsidianFile[];
	emptyFolders: string[];
}> {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) {
		return { files: [], emptyFolders: [] };
	}
	const desktopRequire =
		typeof (globalThis as { require?: unknown }).require === "function"
			? ((globalThis as { require: (id: string) => unknown }).require)
			: null;
	if (!desktopRequire) {
		return collectTrackedObsidianAdapterState(app, ignorePaths);
	}
	const { lstat, readdir, realpath, stat } = desktopRequire("fs/promises") as NodeFsPromises;
	const pathModule = desktopRequire("path") as NodePath;
	const rootAbsolute = pathModule.join(adapter.getBasePath(), OBSIDIAN_ROOT);
	const rootStat = await lstat(rootAbsolute).catch(() => null);
	if (!rootStat) {
		return { files: [], emptyFolders: [] };
	}
	const files: TrackedObsidianFile[] = [];
	const emptyFolders: string[] = [];
	const visitedDirectories = new Set<string>();

	const visitPath = async (logicalPath: string, absolutePath: string): Promise<boolean> => {
		const normalizedLogical = normalizePath(logicalPath);
		if (
			normalizedLogical !== OBSIDIAN_ROOT &&
			!shouldTrackObsidianPath(normalizedLogical, ignorePaths)
		) {
			return false;
		}
		const entryStat = await lstat(absolutePath).catch(() => null);
		if (!entryStat) {
			return false;
		}
		if (entryStat.isSymbolicLink()) {
			const resolvedPath = await realpath(absolutePath).catch(() => null);
			if (!resolvedPath) {
				return false;
			}
			const resolvedStat = await stat(resolvedPath).catch(() => null);
			if (!resolvedStat) {
				return false;
			}
			if (resolvedStat.isDirectory()) {
				return visitDirectory(normalizedLogical, resolvedPath);
			}
			if (resolvedStat.isFile()) {
				files.push({
					path: normalizedLogical,
					updatedAtMs: resolvedStat.mtimeMs,
				});
				return true;
			}
			return false;
		}
		if (entryStat.isDirectory()) {
			return visitDirectory(normalizedLogical, absolutePath);
		}
		if (entryStat.isFile()) {
			files.push({
				path: normalizedLogical,
				updatedAtMs: entryStat.mtimeMs,
			});
			return true;
		}
		return false;
	};

	const visitDirectory = async (
		logicalPath: string,
		absolutePath: string,
	): Promise<boolean> => {
		const realDirectory = await realpath(absolutePath).catch(() => absolutePath);
		const visitKey = `${logicalPath}::${realDirectory}`;
		if (visitedDirectories.has(visitKey)) {
			return false;
		}
		visitedDirectories.add(visitKey);
		const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => []);
		let trackedChildren = 0;
		for (const entry of entries) {
			const logicalChild = normalizePath(`${logicalPath}/${entry.name}`);
			const absoluteChild = pathModule.join(absolutePath, entry.name);
			const tracked = await visitPath(logicalChild, absoluteChild);
			if (tracked) {
				trackedChildren += 1;
			}
		}
		if (
			logicalPath !== OBSIDIAN_ROOT &&
			shouldTrackObsidianPath(logicalPath, ignorePaths) &&
			trackedChildren === 0
		) {
			emptyFolders.push(logicalPath);
		}
		return true;
	};

	await visitPath(OBSIDIAN_ROOT, rootAbsolute);
	return { files, emptyFolders };
}

async function collectTrackedObsidianAdapterState(
	app: App,
	ignorePaths: string[],
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

export async function collectTrackedObsidianState(
	app: App,
	ignorePaths: string[] = [],
): Promise<{
	files: TrackedObsidianFile[];
	emptyFolders: string[];
}> {
	if (app.vault.adapter instanceof FileSystemAdapter) {
		return collectTrackedObsidianFsState(app, ignorePaths);
	}
	return collectTrackedObsidianAdapterState(app, ignorePaths);
}
