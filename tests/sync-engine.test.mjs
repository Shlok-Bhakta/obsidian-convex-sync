import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
	mergeTextContent,
	shouldCompactFileHistory,
	FILE_WAL_COMPACTION_BYTES_THRESHOLD,
} = jiti("../convex/_lib/fileSyncEngine.ts");
const {
	decideBinaryCommit,
	decideDeleteCommit,
	decideRenameCommit,
	decideTextCommit,
} = jiti("../convex/_lib/fileSyncProtocol.ts");
const { InMemorySyncStateStore } = jiti("../src/sync/state-store.ts");

test("mergeTextContent auto-merges disjoint offline text edits", () => {
	const base = "first\nsecond\nthird\n";
	const current = "first\nsecond changed\nthird\n";
	const incoming = "intro\nfirst\nsecond\nthird\n";
	assert.deepEqual(mergeTextContent(base, current, incoming), {
		ok: true,
		mergedText: "intro\nfirst\nsecond changed\nthird\n",
	});
});

test("mergeTextContent conflicts on overlapping text edits", () => {
	const base = "alpha\nbeta\ngamma\n";
	const current = "alpha\nleft change\ngamma\n";
	const incoming = "alpha\nright change\ngamma\n";
	assert.deepEqual(mergeTextContent(base, current, incoming), {
		ok: false,
		reason: "conflict",
	});
});

test("mergeTextContent preserves concurrent inserts at the same point", () => {
	const base = "Links to [[First Note]]\n";
	const current = "Links to [[First Note]]\n!!!!!!!!!!";
	const incoming = "Links to [[First Note]]\n??????????";
	assert.deepEqual(mergeTextContent(base, current, incoming), {
		ok: true,
		mergedText: "Links to [[First Note]]\n!!!!!!!!!!??????????",
	});
});

test("decideTextCommit models reconnect merge for two offline devices", () => {
	const decision = decideTextCommit({
		headRevision: 2,
		baseRevision: 1,
		deleted: false,
		baseText: "line 1\nline 2\nline 3\n",
		currentText: "line 1\nline 2 from device A\nline 3\n",
		incomingText: "header\nline 1\nline 2\nline 3\n",
	});
	assert.deepEqual(decision, {
		kind: "merged",
		mergedText: "header\nline 1\nline 2 from device A\nline 3\n",
	});
});

test("decideBinaryCommit forces conflicts for stale binary edits", () => {
	assert.deepEqual(
		decideBinaryCommit({ headRevision: 3, baseRevision: 2, deleted: false }),
		{ kind: "conflict", conflictType: "binary" },
	);
});

test("rename plus stale edit keeps file identity and allows text merge", () => {
	assert.deepEqual(
		decideRenameCommit({ headRevision: 4, baseRevision: 4, deleted: false }),
		{ kind: "fast_forward" },
	);
	assert.deepEqual(
		decideTextCommit({
			headRevision: 5,
			baseRevision: 4,
			deleted: false,
			baseText: "a\nb\n",
			currentText: "a\nb\nrenamed context\n",
			incomingText: "prefix\na\nb\n",
		}),
		{ kind: "merged", mergedText: "prefix\na\nb\nrenamed context\n" },
	);
});

test("delete plus edit race becomes a delete conflict", () => {
	assert.deepEqual(
		decideDeleteCommit({ headRevision: 9, baseRevision: 9, deleted: false }),
		{ kind: "fast_forward" },
	);
	assert.deepEqual(
		decideTextCommit({
			headRevision: 10,
			baseRevision: 9,
			deleted: true,
			baseText: "before delete\n",
			currentText: null,
			incomingText: "edited offline\n",
		}),
		{ kind: "conflict", conflictType: "delete" },
	);
});

test("shouldCompactFileHistory trips on bytes threshold and stale churn", () => {
	assert.equal(
		shouldCompactFileHistory({
			opsSinceSnapshot: 1,
			bytesSinceSnapshot: FILE_WAL_COMPACTION_BYTES_THRESHOLD,
			lastCompactedAtMs: Date.now(),
			now: Date.now(),
			hasRecentChurn: true,
		}),
		true,
	);
	assert.equal(
		shouldCompactFileHistory({
			opsSinceSnapshot: 2,
			bytesSinceSnapshot: 10,
			lastCompactedAtMs: Date.now() - 8 * 24 * 60 * 60 * 1000,
			now: Date.now(),
			hasRecentChurn: true,
		}),
		true,
	);
});

test("InMemorySyncStateStore keeps cursor, metadata, and latest outbox payloads", async () => {
	const store = new InMemorySyncStateStore();
	await store.setLastSeenCursor(42);
	await store.putMetadata({
		fileId: "file-1",
		path: "notes/a.md",
		revision: 3,
		deleted: false,
		updatedAtMs: 100,
		contentHash: "abc",
		contentKind: "text",
	});
	await store.putMetadata({
		fileId: "file-1",
		path: "notes/b.md",
		revision: 4,
		deleted: false,
		updatedAtMs: 200,
		contentHash: "def",
		contentKind: "text",
	});
	await store.queueUpsert({
		fileId: "file-1",
		path: "notes/b.md",
		textContent: "draft 1",
		updatedAtMs: 300,
	});
	await store.queueUpsert({
		fileId: "file-1",
		path: "notes/b.md",
		textContent: "draft 2",
		updatedAtMs: 301,
	});
	await store.queueUpsert({
		fileId: "file-1",
		path: "notes/b.md",
		updatedAtMs: 302,
	});

	assert.equal(await store.getLastSeenCursor(), 42);
	assert.equal(await store.getMetadataByPath("notes/a.md"), null);
	assert.deepEqual(await store.getMetadataByPath("notes/b.md"), {
		fileId: "file-1",
		path: "notes/b.md",
		revision: 4,
		deleted: false,
		updatedAtMs: 200,
		contentHash: "def",
		contentKind: "text",
	});
	const outbox = await store.listOutbox();
	assert.equal(outbox.length, 1);
	assert.equal(outbox[0].textContent, "draft 2");
	assert.equal(outbox[0].updatedAtMs, 302);
});
