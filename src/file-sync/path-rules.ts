export const ARG_CHUNK_SIZE = 500;
export const OBSIDIAN_ROOT = ".obsidian";

const VAULT_SYNC_IGNORE_PREFIXES = [
	".obsidian/cache/",
	".obsidian/workspace-mobile.json",
];

export function shouldIgnoreVaultPath(path: string): boolean {
	return VAULT_SYNC_IGNORE_PREFIXES.some(
		(prefix) => path === prefix || path.startsWith(prefix),
	);
}

export function isDotObsidianPath(path: string): boolean {
	return path === OBSIDIAN_ROOT || path.startsWith(`${OBSIDIAN_ROOT}/`);
}
