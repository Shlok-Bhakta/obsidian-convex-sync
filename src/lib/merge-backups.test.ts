import { describe, expect, test } from "vitest";
import {
	isMergeBackupPath,
	MERGE_BACKUP_ROOT,
} from "./merge-backups";

	describe("merge backup paths", () => {
	test("existing backup marker is detected anywhere in vault", () => {
		expect(isMergeBackupPath("notes/Untitled.convex-merge-backup-20260425-140000.md")).toBe(true);
		expect(isMergeBackupPath(`${MERGE_BACKUP_ROOT}/notes/Untitled.md`)).toBe(true);
		expect(isMergeBackupPath("notes/Untitled.md")).toBe(false);
	});
});
