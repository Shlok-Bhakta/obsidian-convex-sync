export const MERGE_BACKUP_MARKER = ".convex-merge-backup-";
export const MERGE_BACKUP_ROOT =
	".obsidian/plugins/obsidian-convex-sync/merge-backups";

export function isMergeBackupPath(path: string): boolean {
	const normalized = normalizeVaultPath(path);
	return (
		normalized.includes(MERGE_BACKUP_MARKER) ||
		normalized === MERGE_BACKUP_ROOT ||
		normalized.startsWith(`${MERGE_BACKUP_ROOT}/`)
	);
}

function normalizeVaultPath(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}
