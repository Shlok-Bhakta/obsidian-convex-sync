import { normalizePath } from "obsidian";

export const DEFAULT_SYNC_IGNORE_PATHS = [
	".obsidian/cache/",
	".obsidian/workspace.json",
	".obsidian/workspace-mobile.json",
];

function normalizeIgnorePath(value: string): string | null {
	const trimmed = value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (trimmed === "") {
		return null;
	}
	if (trimmed.endsWith("/")) {
		const inner = trimmed.slice(0, -1);
		return inner === "" ? null : `${normalizePath(inner)}/`;
	}
	return normalizePath(trimmed);
}

export function normalizeSyncIgnorePaths(raw: unknown): string[] {
	if (!Array.isArray(raw)) {
		return [...DEFAULT_SYNC_IGNORE_PATHS];
	}
	const normalized = new Set<string>();
	for (const entry of [...DEFAULT_SYNC_IGNORE_PATHS, ...raw]) {
		if (typeof entry !== "string") {
			continue;
		}
		const value = normalizeIgnorePath(entry);
		if (value) {
			normalized.add(value);
		}
	}
	return [...normalized];
}

export function matchesSyncIgnorePath(path: string, ignorePaths: string[]): boolean {
	const normalizedPath = normalizePath(path);
	for (const entry of ignorePaths) {
		const normalizedEntry = normalizeIgnorePath(entry);
		if (!normalizedEntry) {
			continue;
		}
		if (normalizedEntry.endsWith("/")) {
			const prefix = normalizedEntry.slice(0, -1);
			if (normalizedPath === prefix || normalizedPath.startsWith(normalizedEntry)) {
				return true;
			}
			continue;
		}
		if (normalizedPath === normalizedEntry) {
			return true;
		}
	}
	return false;
}
