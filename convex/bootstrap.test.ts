import * as Automerge from "@automerge/automerge";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import {
	applyTextChange,
	archiveEntryBytes,
	bytesToBase64,
	createBinaryDoc,
	createTextDoc,
	newTextDoc,
	readBootstrapArchive,
} from "./test.helpers";
import { makeConvexTest, seedPluginSecret } from "./test.setup";

test("buildArchive creates a zip with text docs, nested paths, binary docs, and .obsidian files", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await createTextDoc(t, secret, {
		docId: "doc-note",
		path: "notes/projects/todo.md",
		text: "# Todo\n- ship tests",
	});
	await createTextDoc(t, secret, {
		docId: "doc-core-plugins",
		path: ".obsidian/core-plugins.json",
		text: '["obsidian-convex-sync"]',
	});
	await createBinaryDoc(t, secret, {
		docId: "doc-binary",
		path: ".obsidian/icons/icon.bin",
		bytes: new Uint8Array([1, 2, 3, 4]),
	});

	const bootstrapId = await t.run(async (ctx) =>
		ctx.db.insert("vaultBootstraps", {
			status: "building",
			phase: "Queued",
			filesProcessed: 0,
			filesTotal: 3,
			bytesProcessed: 0,
			bytesTotal: 0,
			startedAtMs: Date.now(),
			createdByClientId: "bootstrap-client",
			archiveName: "vault.zip",
		}),
	);

	await t.action(internal.bootstrap.buildArchive, {
		bootstrapId,
		convexSecret: secret,
	});

	const archive = await readBootstrapArchive(t, String(bootstrapId));
	expect(new TextDecoder().decode(archiveEntryBytes(archive, "notes/projects/todo.md"))).toBe(
		"# Todo\n- ship tests",
	);
	expect(
		new TextDecoder().decode(archiveEntryBytes(archive, ".obsidian/core-plugins.json")),
	).toBe(
		'["obsidian-convex-sync"]',
	);
	expect(Array.from(archiveEntryBytes(archive, ".obsidian/icons/icon.bin"))).toEqual([
		1, 2, 3, 4,
	]);
});

test("finalizeArchive does not revive a canceled bootstrap", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);

	await t.run(async (ctx) => {
		await ctx.db.insert("vaultBootstraps", {
			status: "building",
			phase: "Queued",
			filesProcessed: 0,
			filesTotal: 0,
			bytesProcessed: 0,
			bytesTotal: 0,
			startedAtMs: Date.now(),
			createdByClientId: "bootstrap-client",
			archiveName: "vault.zip",
		});
	});

	await t.mutation(api.bootstrap.cancelBootstrap, {
		convexSecret: secret,
	});

	const row = await t.run(async (ctx) => ctx.db.query("vaultBootstraps").first());
	expect(row).not.toBeNull();

	const storageId = await t.run(async (ctx) =>
		ctx.storage.store(new Blob([new Uint8Array([9, 9, 9])], { type: "application/zip" })),
	);
	await t.mutation(internal.bootstrap.finalizeArchive, {
		bootstrapId: row!._id,
		storageId,
		contentHash: "abc123",
		sizeBytes: 3,
	});

	const afterFinalize = await t.run(async (ctx) => ctx.db.get(row!._id));
	expect(afterFinalize?.status).toBe("expired");
	expect(afterFinalize?.storageId).toBeUndefined();
});

test("buildArchive materializes the latest text state from snapshot plus incremental ops", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: "doc-live-json",
		path: ".obsidian/graph.json",
		kind: "text",
		clientId: "creator",
	});

	let doc = newTextDoc("6".repeat(32));
	const first = applyTextChange(doc, '{"collapse-filter":false}');
	doc = first.doc;
	const snapshotBytes = Automerge.save(doc);
	const snapshotStorageId = await t.run(async (ctx) =>
		ctx.storage.store(new Blob([snapshotBytes], { type: "application/octet-stream" })),
	);
	await t.mutation(api.sync.replaceDocSnapshot, {
		convexSecret: secret,
		docId: "doc-live-json",
		clientId: "creator",
		baseServerSeq: 0,
		clientSeqs: [1],
		snapshotStorageId,
		snapshotSizeBytes: snapshotBytes.byteLength,
	});

	const second = applyTextChange(doc, '{"collapse-filter":false,"search":"tag:#todo"}');
	await t.mutation(api.sync.appendOps, {
		convexSecret: secret,
		docId: "doc-live-json",
		clientId: "creator",
		ops: [
			{
				clientSeq: 2,
				changeBytesBase64: bytesToBase64(second.changeBytes),
				timestampMs: 2,
			},
		],
	});

	const bootstrapId = await t.run(async (ctx) =>
		ctx.db.insert("vaultBootstraps", {
			status: "building",
			phase: "Queued",
			filesProcessed: 0,
			filesTotal: 1,
			bytesProcessed: 0,
			bytesTotal: 0,
			startedAtMs: Date.now(),
			createdByClientId: "bootstrap-client",
			archiveName: "vault.zip",
		}),
	);
	await t.action(internal.bootstrap.buildArchive, {
		bootstrapId,
		convexSecret: secret,
	});

	const archive = await readBootstrapArchive(t, String(bootstrapId));
	expect(new TextDecoder().decode(archiveEntryBytes(archive, ".obsidian/graph.json"))).toBe(
		'{"collapse-filter":false,"search":"tag:#todo"}',
	);
});

test("buildArchive excludes docs that were deleted before bootstrap creation", async () => {
	const t = makeConvexTest();
	const secret = await seedPluginSecret(t);
	await createTextDoc(t, secret, {
		docId: "doc-live",
		path: "notes/live.md",
		text: "keep me",
	});
	await createTextDoc(t, secret, {
		docId: "doc-deleted",
		path: ".obsidian/community-plugins.json",
		text: '["a-plugin"]',
	});
	await t.mutation(api.sync.deleteDoc, {
		convexSecret: secret,
		docId: "doc-deleted",
		clientId: "deleter",
		timestampMs: 1_000,
		trashRetentionDays: 30,
	});

	const bootstrapId = await t.run(async (ctx) =>
		ctx.db.insert("vaultBootstraps", {
			status: "building",
			phase: "Queued",
			filesProcessed: 0,
			filesTotal: 1,
			bytesProcessed: 0,
			bytesTotal: 0,
			startedAtMs: Date.now(),
			createdByClientId: "bootstrap-client",
			archiveName: "vault.zip",
		}),
	);
	await t.action(internal.bootstrap.buildArchive, {
		bootstrapId,
		convexSecret: secret,
	});

	const archive = await readBootstrapArchive(t, String(bootstrapId));
	expect(Object.keys(archive).sort()).toEqual(["notes/live.md"]);
	expect(new TextDecoder().decode(archiveEntryBytes(archive, "notes/live.md"))).toBe(
		"keep me",
	);
});
