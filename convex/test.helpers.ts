import * as Automerge from "@automerge/automerge";
import { unzipSync } from "fflate";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { makeConvexTest } from "./test.setup";

type TextDoc = { text: string };
type TestConvex = ReturnType<typeof makeConvexTest>;

function textValue(doc: Automerge.Doc<TextDoc>): string {
	const value = (doc as { text?: unknown }).text;
	if (typeof value === "string") {
		return value;
	}
	if (value && typeof (value as { toString(): string }).toString === "function") {
		return (value as { toString(): string }).toString();
	}
	return "";
}

export function applyTextChange(
	doc: Automerge.Doc<TextDoc>,
	text: string,
): { doc: Automerge.Doc<TextDoc>; changeBytes: Uint8Array } {
	const nextDoc = Automerge.change(doc, (draft: any) => {
		draft.text = text;
	});
	const changeBytes = Automerge.getLastLocalChange(nextDoc);
	if (!changeBytes) {
		throw new Error("expected a local automerge change");
	}
	return { doc: nextDoc, changeBytes };
}

export function newTextDoc(actor: string): Automerge.Doc<TextDoc> {
	return Automerge.init<TextDoc>({ actor });
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export function archiveEntryBytes(
	archive: Record<string, number[]>,
	path: string,
): Uint8Array {
	const entry = archive[path];
	if (!entry) {
		throw new Error(`archive entry missing: ${path}`);
	}
	return new Uint8Array(entry);
}

export async function createTextDoc(
	t: TestConvex,
	secret: string,
	args: {
		docId: string;
		path: string;
		text: string;
		clientId?: string;
		clientSeq?: number;
	},
): Promise<void> {
	const clientId = args.clientId ?? "test-client";
	const clientSeq = args.clientSeq ?? 1;
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: args.docId,
		path: args.path,
		kind: "text",
		clientId,
	});
	let doc = newTextDoc("a".repeat(32));
	({ doc } = applyTextChange(doc, args.text));
	const snapshotBytes = Automerge.save(doc);
	const storageId = await t.run(async (ctx) =>
		ctx.storage.store(new Blob([snapshotBytes], { type: "application/octet-stream" })),
	);
	await t.mutation(api.sync.replaceDocSnapshot, {
		convexSecret: secret,
		docId: args.docId,
		clientId,
		baseServerSeq: 0,
		clientSeqs: [clientSeq],
		snapshotStorageId: storageId,
		snapshotSizeBytes: snapshotBytes.byteLength,
	});
}

export async function createBinaryDoc(
	t: TestConvex,
	secret: string,
	args: {
		docId: string;
		path: string;
		bytes: Uint8Array;
		clientId?: string;
		updatedAtMs?: number;
	},
): Promise<void> {
	const clientId = args.clientId ?? "binary-client";
	await t.mutation(api.sync.createDoc, {
		convexSecret: secret,
		docId: args.docId,
		path: args.path,
		kind: "binary",
		clientId,
	});
	const storageId = await t.run(async (ctx) =>
		ctx.storage.store(new Blob([args.bytes], { type: "application/octet-stream" })),
	);
	await t.mutation(api.sync.putBinaryVersion, {
		convexSecret: secret,
		docId: args.docId,
		storageId,
		contentHash: Array.from(args.bytes)
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join(""),
		sizeBytes: args.bytes.byteLength,
		updatedAtMs: args.updatedAtMs ?? Date.now(),
		clientId,
		retentionCount: 5,
	});
}

export async function readTextDoc(
	t: TestConvex,
	docId: string,
): Promise<string> {
	const payload = await t.run(async (ctx) => {
		const snapshots = await ctx.db
			.query("docSnapshots")
			.withIndex("by_doc_seq", (q) => q.eq("docId", docId))
			.order("desc")
			.take(1);
		const snapshot = snapshots[0] ?? null;
		const ops = await ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q) => q.eq("docId", docId))
			.collect();
		const snapshotBytes = snapshot
			? await ctx.storage.get(snapshot.storageId).then(async (blob) =>
					blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null,
				)
			: null;
		return {
			snapshotBytes,
			ops: ops
				.sort((a, b) => a.seq - b.seq)
				.map((op) => Array.from(new Uint8Array(op.changeBytes))),
		};
	});
	let doc = payload.snapshotBytes
		? Automerge.load<TextDoc>(new Uint8Array(payload.snapshotBytes))
		: Automerge.init<TextDoc>();
	if (payload.ops.length > 0) {
		doc = Automerge.applyChanges(
			doc,
			payload.ops.map((bytes) => new Uint8Array(bytes)),
		)[0];
	}
	return textValue(doc);
}

export async function getDocByDocId(
	t: TestConvex,
	docId: string,
): Promise<Doc<"docs"> | null> {
	return t.run(async (ctx) =>
		ctx.db
			.query("docs")
			.withIndex("by_docId", (q) => q.eq("docId", docId))
			.unique(),
	);
}

export async function readBootstrapArchive(
	t: TestConvex,
	bootstrapId: string,
): Promise<Record<string, number[]>> {
	return t.run(async (ctx) => {
		const row = await ctx.db.get(bootstrapId as any);
		if (!row?.storageId) {
			throw new Error("bootstrap archive not found");
		}
		const blob = await ctx.storage.get(row.storageId);
		if (!blob) {
			throw new Error("bootstrap blob missing");
		}
		return Object.fromEntries(
			Object.entries(unzipSync(new Uint8Array(await blob.arrayBuffer()))).map(
				([path, bytes]) => [path, Array.from(bytes)],
			),
		);
	});
}
