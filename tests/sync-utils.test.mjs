import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { detectContentKind } = jiti("../src/sync/binary.ts");
const { hasSameCachedContent } = jiti("../src/file-sync.ts");
const { parseIgnoreRules, isPathIgnored, shouldSyncPath } = jiti(
	"../src/sync/policy.ts",
);

test("detectContentKind treats utf-8 text as text", () => {
	const bytes = new TextEncoder().encode("Hello from Obsidian sync.\n");
	assert.equal(detectContentKind(bytes), "text");
});

test("detectContentKind treats nul bytes as binary", () => {
	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
	assert.equal(detectContentKind(bytes), "binary");
});

test("parseIgnoreRules expands .obsidian aliases against the active config dir", () => {
	const rules = parseIgnoreRules(
		{
			syncIgnorePaths: ".obsidian/cache\nfolder/subfolder\n# comment\n",
		},
		".config-obsidian",
	);
	assert.deepEqual(rules, [".config-obsidian/cache", "folder/subfolder"]);
});

test("isPathIgnored matches both exact paths and descendants", () => {
	const ignored = ["folder/subfolder", ".obsidian/cache"];
	assert.equal(isPathIgnored("folder/subfolder", ignored), true);
	assert.equal(isPathIgnored("folder/subfolder/file.md", ignored), true);
	assert.equal(isPathIgnored("folder/other/file.md", ignored), false);
});

test("shouldSyncPath rejects ignored and symlinked descendants", () => {
	const options = {
		configDir: ".obsidian",
		ignoredPaths: ["ignored/path"],
		syncDotObsidian: true,
		symlinkedPaths: new Set(["linked"]),
	};

	assert.equal(shouldSyncPath({ ...options, path: "notes/file.md" }), true);
	assert.equal(shouldSyncPath({ ...options, path: "ignored/path/file.md" }), false);
	assert.equal(shouldSyncPath({ ...options, path: "linked/file.md" }), false);
});

test("hasSameCachedContent only trusts matching content hashes", () => {
	assert.equal(hasSameCachedContent({ contentHash: "abc" }, "abc"), true);
	assert.equal(hasSameCachedContent({ contentHash: "abc" }, "def"), false);
	assert.equal(hasSameCachedContent({ contentHash: null }, "abc"), false);
	assert.equal(hasSameCachedContent(null, "abc"), false);
});
