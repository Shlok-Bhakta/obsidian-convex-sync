import * as Automerge from "@automerge/automerge";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { makeConvexTest, seedPluginSecret } from "./test.setup";
import {
	applyTextChange,
	bytesToBase64,
	createTextDoc,
	getDocByDocId,
	newTextDoc,
	readTextDoc,
} from "./test.helpers";

type TextDoc = { text: string };

test("appendOps stores sequential text edits and pullDoc exposes both ops", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: "doc-sequential",
		path: "notes/sequential.md",
		kind: "text",
		clientId: "client-a",
	});

	let doc = newTextDoc("a".repeat(32));
	const first = applyTextChange(doc, "hello");
	doc = first.doc;
	const second = applyTextChange(doc, "hello world");

	await t.mutation(api.sync.appendOps, {
		convexSecret: secret,
		docId: "doc-sequential",
		clientId: "client-a",
		ops: [
			{
				clientSeq: 1,
				changeBytesBase64: bytesToBase64(first.changeBytes),
				timestampMs: 1,
			},
		],
	});
	await t.mutation(api.sync.appendOps, {
		convexSecret: secret,
		docId: "doc-sequential",
		clientId: "client-a",
		ops: [
			{
				clientSeq: 2,
				changeBytesBase64: bytesToBase64(second.changeBytes),
				timestampMs: 2,
			},
		],
	});

	const payload = await t.query(api.sync.pullDoc, {
		convexSecret: secret,
		docId: "doc-sequential",
		afterSeq: 0,
	});
	expect(payload?.ops).toHaveLength(2);
	expect(await readTextDoc(t, "doc-sequential")).toBe("hello world");
});

test("appendOps can merge edits from two clients on the same doc", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: "doc-concurrent",
		path: "notes/concurrent.md",
		kind: "text",
		clientId: "creator",
	});

	const changeA = applyTextChange(newTextDoc("1".repeat(32)), "Alpha");
	const changeB = applyTextChange(newTextDoc("2".repeat(32)), "Beta");

	await t.mutation(api.sync.appendOps, {
		convexSecret: secret,
		docId: "doc-concurrent",
		clientId: "client-a",
		ops: [
			{
				clientSeq: 1,
				changeBytesBase64: bytesToBase64(changeA.changeBytes),
				timestampMs: 1,
			},
		],
	});
	await t.mutation(api.sync.appendOps, {
		convexSecret: secret,
		docId: "doc-concurrent",
		clientId: "client-b",
		ops: [
			{
				clientSeq: 1,
				changeBytesBase64: bytesToBase64(changeB.changeBytes),
				timestampMs: 2,
			},
		],
	});

	const expected = Automerge.applyChanges(
		Automerge.init<TextDoc>(),
		[changeA.changeBytes, changeB.changeBytes],
	)[0];
	const expectedText = String((expected as { text?: unknown }).text ?? "");
	expect(await readTextDoc(t, "doc-concurrent")).toBe(expectedText);
});

test("large paste falls back to replaceDocSnapshot after appendOps rejects oversized payloads", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: "doc-large",
		path: "notes/large.md",
		kind: "text",
		clientId: "creator",
	});

	let largeDoc = newTextDoc("f".repeat(32));
	const hugeText = "paste-".repeat(50_000);
	const hugeChange = applyTextChange(largeDoc, hugeText);
	largeDoc = hugeChange.doc;
	expect(hugeChange.changeBytes.byteLength).toBeGreaterThan(200_000);

	await expect(
		t.mutation(api.sync.appendOps, {
			convexSecret: secret,
			docId: "doc-large",
			clientId: "client-large",
			ops: [
				{
					clientSeq: 1,
					changeBytesBase64: bytesToBase64(hugeChange.changeBytes),
					timestampMs: 1,
				},
			],
		}),
	).rejects.toThrowError("payload is too large");

	const snapshotBytes = Automerge.save(largeDoc);
	const storageId = await t.run(async (ctx) =>
		ctx.storage.store(new Blob([snapshotBytes], { type: "application/octet-stream" })),
	);
	const result = await t.mutation(api.sync.replaceDocSnapshot, {
		convexSecret: secret,
		docId: "doc-large",
		clientId: "client-large",
		baseServerSeq: 0,
		clientSeqs: [1],
		snapshotStorageId: storageId,
		snapshotSizeBytes: snapshotBytes.byteLength,
	});

	expect(result.assignedSeqs).toEqual([1]);
	expect(await readTextDoc(t, "doc-large")).toBe(hugeText);
});

test("appendOps de-duplicates retried client sequences instead of duplicating changes", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: "doc-dedupe",
		path: "notes/dedupe.md",
		kind: "text",
		clientId: "creator",
	});

	const change = applyTextChange(newTextDoc("d".repeat(32)), "same retry");
	const firstResult = await t.mutation(api.sync.appendOps, {
		convexSecret: secret,
		docId: "doc-dedupe",
		clientId: "client-a",
		ops: [
			{
				clientSeq: 7,
				changeBytesBase64: bytesToBase64(change.changeBytes),
				timestampMs: 1,
			},
		],
	});
	const secondResult = await t.mutation(api.sync.appendOps, {
		convexSecret: secret,
		docId: "doc-dedupe",
		clientId: "client-a",
		ops: [
			{
				clientSeq: 7,
				changeBytesBase64: bytesToBase64(change.changeBytes),
				timestampMs: 2,
			},
		],
	});

	const ops = await t.run(async (ctx) =>
		ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q) => q.eq("docId", "doc-dedupe"))
			.collect(),
	);
	expect(firstResult.assignedSeqs).toEqual([1]);
	expect(secondResult.assignedSeqs).toEqual([1]);
	expect(ops).toHaveLength(1);
	expect(await readTextDoc(t, "doc-dedupe")).toBe("same retry");
});

test("stale concurrent large snapshot replacement is rejected without overwriting newer data", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: "doc-large-race",
		path: "notes/large-race.md",
		kind: "text",
		clientId: "creator",
	});

	const firstState = applyTextChange(newTextDoc("9".repeat(32)), "A".repeat(260_000)).doc;
	const secondState = applyTextChange(newTextDoc("8".repeat(32)), "B".repeat(260_000)).doc;

	const firstSnapshot = Automerge.save(firstState);
	const firstStorageId = await t.run(async (ctx) =>
		ctx.storage.store(new Blob([firstSnapshot], { type: "application/octet-stream" })),
	);
	const accepted = await t.mutation(api.sync.replaceDocSnapshot, {
		convexSecret: secret,
		docId: "doc-large-race",
		clientId: "client-a",
		baseServerSeq: 0,
		clientSeqs: [1],
		snapshotStorageId: firstStorageId,
		snapshotSizeBytes: firstSnapshot.byteLength,
	});
	expect(accepted.assignedSeqs).toEqual([1]);

	const secondSnapshot = Automerge.save(secondState);
	const secondStorageId = await t.run(async (ctx) =>
		ctx.storage.store(new Blob([secondSnapshot], { type: "application/octet-stream" })),
	);
	await expect(
		t.mutation(api.sync.replaceDocSnapshot, {
			convexSecret: secret,
			docId: "doc-large-race",
			clientId: "client-b",
			baseServerSeq: 0,
			clientSeqs: [1],
			snapshotStorageId: secondStorageId,
			snapshotSizeBytes: secondSnapshot.byteLength,
		}),
	).rejects.toThrowError("doc advanced before snapshot upload completed");
	expect(await readTextDoc(t, "doc-large-race")).toBe("A".repeat(260_000));
});

test("putBinaryVersion enforces retention and keeps the newest blobs", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: "doc-binary",
		path: "assets/blob.bin",
		kind: "binary",
		clientId: "binary-client",
	});

	for (const [index, label] of ["one", "two", "three"].entries()) {
		const bytes = new TextEncoder().encode(label);
		const storageId = await t.run(async (ctx) =>
			ctx.storage.store(new Blob([bytes], { type: "application/octet-stream" })),
		);
		await t.mutation(api.sync.putBinaryVersion, {
			convexSecret: secret,
			docId: "doc-binary",
			storageId,
			contentHash: label,
			sizeBytes: bytes.byteLength,
			updatedAtMs: index + 1,
			clientId: "binary-client",
			retentionCount: 2,
		});
	}

	const versions = await t.run(async (ctx) =>
		ctx.db
			.query("binaryVersions")
			.withIndex("by_doc_time", (q) => q.eq("docId", "doc-binary"))
			.order("desc")
			.collect(),
	);
	expect(versions).toHaveLength(2);
	expect(versions.map((row) => row.contentHash)).toEqual(["three", "two"]);
});

test("moveDoc updates the live path and the trash restore path together", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await createTextDoc(t, secret, {
		docId: "doc-move-trash",
		path: "notes/original.md",
		text: "rename me",
	});

	await t.mutation(api.sync.deleteDoc, {
		convexSecret: secret,
		docId: "doc-move-trash",
		clientId: "deleter",
		timestampMs: 100,
		trashRetentionDays: 30,
	});
	await t.mutation(api.sync.moveDoc, {
		convexSecret: secret,
		docId: "doc-move-trash",
		newPath: "notes/renamed.md",
		timestampMs: 200,
		clientId: "mover",
	});
	await t.mutation(api.sync.restoreFromTrash, {
		convexSecret: secret,
		docId: "doc-move-trash",
		clientId: "restorer",
	});

	const restored = await getDocByDocId(t, "doc-move-trash");
	expect(restored?.path).toBe("notes/renamed.md");
	expect(await readTextDoc(t, "doc-move-trash")).toBe("rename me");
});

test("deleteDoc moves docs to trash and restoreFromTrash revives the same path", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await createTextDoc(t, secret, {
		docId: "doc-restore",
		path: "notes/restore.md",
		text: "restore me",
	});

	await t.mutation(api.sync.deleteDoc, {
		convexSecret: secret,
		docId: "doc-restore",
		clientId: "deleter",
		timestampMs: 1234,
		trashRetentionDays: 30,
	});

	const deletedDoc = await getDocByDocId(t, "doc-restore");
	const trashRow = await t.run(async (ctx) =>
		ctx.db
			.query("trashedDocs")
			.withIndex("by_docId", (q) => q.eq("docId", "doc-restore"))
			.unique(),
	);
	expect(deletedDoc?.deletedAtMs).toBe(1234);
	expect(trashRow?.originalPath).toBe("notes/restore.md");

	await t.mutation(api.sync.restoreFromTrash, {
		convexSecret: secret,
		docId: "doc-restore",
		clientId: "restorer",
	});

	const restoredDoc = await getDocByDocId(t, "doc-restore");
	const restoredTrashRow = await t.run(async (ctx) =>
		ctx.db
			.query("trashedDocs")
			.withIndex("by_docId", (q) => q.eq("docId", "doc-restore"))
			.unique(),
	);
	expect(restoredDoc?.deletedAtMs).toBeUndefined();
	expect(restoredDoc?.path).toBe("notes/restore.md");
	expect(restoredTrashRow).toBeNull();
	expect(await readTextDoc(t, "doc-restore")).toBe("restore me");
});

test("compaction preserves document contents and removes compacted ops", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: "doc-compact",
		path: "notes/compact.md",
		kind: "text",
		clientId: "creator",
	});

	let doc = newTextDoc("c".repeat(32));
	const changes: Uint8Array[] = [];
	for (const text of [
		"draft 1",
		"draft 2",
		"draft 3",
		"draft 4",
		"final draft with enough history",
	]) {
		const result = applyTextChange(doc, text);
		doc = result.doc;
		changes.push(result.changeBytes);
	}

	await t.mutation(api.sync.appendOps, {
		convexSecret: secret,
		docId: "doc-compact",
		clientId: "client-compact",
		ops: changes.map((changeBytes, index) => ({
			clientSeq: index + 1,
			changeBytesBase64: bytesToBase64(changeBytes),
			timestampMs: index + 1,
		})),
	});

	const beforeCompactionOps = await t.run(async (ctx) =>
		ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q) => q.eq("docId", "doc-compact"))
			.collect(),
	);
	expect(beforeCompactionOps).toHaveLength(5);

	const compacted = await t.action(internal.sync.compactDoc, {
		docId: "doc-compact",
	});
	expect(compacted).toEqual({ ok: true, compacted: true });
	expect(await readTextDoc(t, "doc-compact")).toBe("final draft with enough history");

	const afterCompactionOps = await t.run(async (ctx) =>
		ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q) => q.eq("docId", "doc-compact"))
			.collect(),
	);
	const snapshots = await t.run(async (ctx) =>
		ctx.db
			.query("docSnapshots")
			.withIndex("by_doc_seq", (q) => q.eq("docId", "doc-compact"))
			.collect(),
	);
	expect(afterCompactionOps).toHaveLength(0);
	expect(snapshots).toHaveLength(1);
});
