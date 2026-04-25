import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import {
	normalizeOptionalVaultPath,
	normalizeVaultPath,
} from "../../convex/_lib/path";

describe("normalizeVaultPath", () => {
	test("normalizes_slashes_and_outer_whitespace", () => {
		expect(normalizeVaultPath("  /folder\\note.md  ")).toBe("folder/note.md");
	});

	test("allows_dotdot_inside_filename", () => {
		expect(normalizeVaultPath("notes..draft.md")).toBe("notes..draft.md");
	});

	test("rejects_path_traversal_segments", () => {
		expect(() => normalizeVaultPath("../secret.md")).toThrow(ConvexError);
		expect(() => normalizeVaultPath("folder/../secret.md")).toThrow(ConvexError);
	});

	test("rejects_empty_paths", () => {
		expect(() => normalizeVaultPath(" / ")).toThrow(ConvexError);
	});
});

describe("normalizeOptionalVaultPath", () => {
	test("returns_null_for_empty_paths", () => {
		expect(normalizeOptionalVaultPath(" / ")).toBeNull();
	});

	test("still_rejects_path_traversal_segments", () => {
		expect(() => normalizeOptionalVaultPath("../secret.md")).toThrow(
			ConvexError,
		);
	});
});
