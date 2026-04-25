import { describe, expect, test } from "vitest";
import { shouldIgnoreVaultPath } from "./path-rules";

describe("file sync path rules", () => {
	test("merge backups are ignored", () => {
		expect(
			shouldIgnoreVaultPath(
				"notes/Untitled.convex-merge-backup-20260425-140000.md",
			),
		).toBe(true);
		expect(
			shouldIgnoreVaultPath(
				".obsidian/plugins/obsidian-convex-sync/merge-backups/notes/Untitled.md",
			),
		).toBe(true);
		expect(shouldIgnoreVaultPath("notes/Untitled.md")).toBe(false);
	});
});
