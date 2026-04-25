import { isMergeBackupPath, MERGE_BACKUP_ROOT } from "../lib/merge-backups";

export const ARG_CHUNK_SIZE = 500;
export const OBSIDIAN_ROOT = ".obsidian";

const VAULT_SYNC_IGNORE_PREFIXES = [
	".obsidian/cache/",
	`${MERGE_BACKUP_ROOT}/`,
	".obsidian/workspace-mobile.json",
];

export function shouldIgnoreVaultPath(path: string): boolean {
	if (isMergeBackupPath(path)) {
		return true;
	}
	return VAULT_SYNC_IGNORE_PREFIXES.some(
		(prefix) => path === prefix || path.startsWith(prefix),
	);
}

export function isDotObsidianPath(path: string): boolean {
	return path === OBSIDIAN_ROOT || path.startsWith(`${OBSIDIAN_ROOT}/`);
}
