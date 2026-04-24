import { FileSystemAdapter, TAbstractFile, normalizePath, type App } from "obsidian";
import { canInspectSymlinks, getConfigDir, shouldSyncPath } from "./policy";
import type { MyPluginSettings } from "../settings";

async function lstatPath(fullPath: string): Promise<{ isSymbolicLink(): boolean }> {
	const fs = await import("fs/promises");
	return fs.lstat(fullPath);
}

export async function collectSymlinkedPaths(
	app: App,
	settings: Pick<MyPluginSettings, "syncIgnorePaths" | "syncDotObsidian">,
): Promise<Set<string>> {
	if (!canInspectSymlinks(app)) {
		return new Set();
	}

	const configDir = getConfigDir(app);
	const ignoredPaths = settings.syncIgnorePaths
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) =>
			normalizePath(
				line === ".obsidian" || line.startsWith(".obsidian/")
					? `${configDir}${line.slice(".obsidian".length)}`
					: line,
			),
		);

	const candidatePaths = new Set<string>();
	for (const entry of app.vault.getAllLoadedFiles()) {
		candidatePaths.add(normalizePath(entry.path));
	}

	if (settings.syncDotObsidian) {
		const queue: string[] = [configDir];
		const visited = new Set<string>();
		while (queue.length > 0) {
			const current = queue.shift();
			if (!current || visited.has(current)) {
				continue;
			}
			visited.add(current);
			if (
				!shouldSyncPath({
					path: current,
					configDir,
					ignoredPaths,
					syncDotObsidian: settings.syncDotObsidian,
				})
			) {
				continue;
			}
			candidatePaths.add(current);
			const fullPath = app.vault.adapter.getFullPath(current);
			try {
				const linkStat = await lstatPath(fullPath);
				if (linkStat.isSymbolicLink()) {
					continue;
				}
			} catch {
				continue;
			}
			const stat = await app.vault.adapter.stat(current);
			if (!stat || stat.type !== "folder") {
				continue;
			}
			const listed = await app.vault.adapter.list(current);
			for (const folder of listed.folders) {
				queue.push(normalizePath(folder));
			}
			for (const file of listed.files) {
				candidatePaths.add(normalizePath(file));
			}
		}
	}

	const symlinked = new Set<string>();
	for (const path of candidatePaths) {
		const fullPath = app.vault.adapter.getFullPath(path);
		try {
			const stat = await lstatPath(fullPath);
			if (stat.isSymbolicLink()) {
				symlinked.add(path);
			}
		} catch {
			continue;
		}
	}
	return symlinked;
}

export function isSymlinkedEntry(
	entry: TAbstractFile,
	symlinkedPaths: ReadonlySet<string>,
): boolean {
	for (const symlinkPath of symlinkedPaths) {
		if (entry.path === symlinkPath || entry.path.startsWith(`${symlinkPath}/`)) {
			return true;
		}
	}
	return false;
}
