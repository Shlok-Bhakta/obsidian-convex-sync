import { FileSystemAdapter, type App } from "obsidian";
import type { MyPluginSettings } from "../settings";

function normalizeSyncPath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function getConfigDir(app: App): string {
	return normalizeSyncPath(app.vault.configDir || ".obsidian");
}

function expandConfigDirAlias(path: string, configDir: string): string {
	if (path === ".obsidian" || path.startsWith(".obsidian/")) {
		return normalizeSyncPath(`${configDir}${path.slice(".obsidian".length)}`);
	}
	return normalizeSyncPath(path);
}

export function parseIgnoreRules(
	settings: Pick<MyPluginSettings, "syncIgnorePaths">,
	configDir: string,
): string[] {
	const seen = new Set<string>();
	const rules: string[] = [];
	for (const rawLine of settings.syncIgnorePaths.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) {
			continue;
		}
		const normalized = expandConfigDirAlias(line, configDir);
		if (!normalized || normalized === ".") {
			continue;
		}
		if (seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		rules.push(normalized.replace(/\/+$/, ""));
	}
	return rules;
}

export function isPathWithin(parent: string, candidate: string): boolean {
	return candidate === parent || candidate.startsWith(`${parent}/`);
}

export function isPathIgnored(path: string, ignoredPaths: readonly string[]): boolean {
	const normalized = normalizeSyncPath(path);
	return ignoredPaths.some((ignored) => isPathWithin(ignored, normalized));
}

export function shouldSyncPath(options: {
	path: string;
	configDir: string;
	ignoredPaths: readonly string[];
	syncDotObsidian: boolean;
	symlinkedPaths?: ReadonlySet<string>;
}): boolean {
	const normalized = normalizeSyncPath(options.path);
	if (!normalized || normalized === ".") {
		return false;
	}
	if (!options.syncDotObsidian && isPathWithin(options.configDir, normalized)) {
		return false;
	}
	if (isPathIgnored(normalized, options.ignoredPaths)) {
		return false;
	}
	if (options.symlinkedPaths) {
		for (const symlinkPath of options.symlinkedPaths) {
			if (isPathWithin(symlinkPath, normalized)) {
				return false;
			}
		}
	}
	return true;
}

export function canInspectSymlinks(app: App): app is App & {
	vault: App["vault"] & { adapter: FileSystemAdapter };
} {
	return app.vault.adapter instanceof FileSystemAdapter;
}
