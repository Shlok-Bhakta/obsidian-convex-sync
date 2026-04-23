// Convex runs in a workerd-style runtime, so we force the workerd Automerge entrypoint here.
// @ts-expect-error Convex's TS program does not pick up declarations for this private path.
import * as Automerge from "../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_workerd.js";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { docKindValidator, normalizeVaultPath } from "./_lib/sync";
import { requirePluginSecret } from "./security";

const DEFAULT_BINARY_RETENTION = 5;
const DEFAULT_TRASH_RETENTION_DAYS = 30;
const HOT_DOC_LIMIT = 25;
const COMPACTION_OP_THRESHOLD = 500;
const COMPACTION_AGE_MS = 60 * 60_000;
const MAX_APPEND_OPS = 50;
const MAX_APPEND_BYTES = 200_000;

type TextDoc = { text: string };

async function getDocByDocId(ctx: any, docId: string) {
	return ctx.db
		.query("docs")
		.withIndex("by_docId", (q: any) => q.eq("docId", docId))
		.unique();
}

async function getTrashRowByDocId(ctx: any, docId: string) {
	return ctx.db
		.query("trashedDocs")
		.withIndex("by_docId", (q: any) => q.eq("docId", docId))
		.unique();
}

async function latestSnapshotForDoc(ctx: any, docId: string) {
	const rows = await ctx.db
		.query("docSnapshots")
		.withIndex("by_doc_seq", (q: any) => q.eq("docId", docId))
		.order("desc")
		.take(1);
	return rows[0] ?? null;
}

async function latestBinaryForDoc(ctx: any, docId: string) {
	const rows = await ctx.db
		.query("binaryVersions")
		.withIndex("by_doc_time", (q: any) => q.eq("docId", docId))
		.order("desc")
		.take(1);
	return rows[0] ?? null;
}

function initTextDoc(text = ""): Automerge.Doc<TextDoc> {
	if (text === "") {
		return Automerge.init<TextDoc>();
	}
	return Automerge.from<TextDoc>({ text });
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function toUint8Array(bytes: ArrayBuffer | Uint8Array): Uint8Array {
	return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

async function snapshotUrl(ctx: any, storageId: any) {
	if (!storageId) {
		return null;
	}
	return ctx.storage.getUrl(storageId);
}

export const issueUploadUrl = mutation({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		return { uploadUrl: await ctx.storage.generateUploadUrl() };
	},
});

export const subscribeIndex = query({
	args: {
		convexSecret: v.string(),
		since: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const since = args.since ?? 0;
		const docs = await ctx.db.query("docs").collect();
		const changed = docs
			.filter((doc: any) => doc.updatedAtMs > since)
			.sort((a: any, b: any) => a.updatedAtMs - b.updatedAtMs);
		const items = [];
		for (const doc of changed) {
			const binaryHead =
				doc.kind === "binary" && !doc.deletedAtMs
					? await latestBinaryForDoc(ctx, doc.docId)
					: null;
			items.push({
				docId: doc.docId,
				kind: doc.kind,
				path: doc.path,
				createdAtMs: doc.createdAtMs,
				updatedAtMs: doc.updatedAtMs,
				latestSeq: doc.latestSeq,
				latestSnapshotSeq: doc.latestSnapshotSeq ?? 0,
				deletedAtMs: doc.deletedAtMs ?? null,
				binaryHead:
					binaryHead === null
						? null
						: {
							contentHash: binaryHead.contentHash,
							sizeBytes: binaryHead.sizeBytes,
							updatedAtMs: binaryHead.updatedAtMs,
							url: await snapshotUrl(ctx, binaryHead.storageId),
						},
			});
		}
		return {
			cursor:
				changed.length > 0
					? (changed[changed.length - 1]?.updatedAtMs ?? since)
					: since,
			docs: items,
		};
	},
});

export const subscribeDoc = query({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		sinceSeq: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc) {
			return null;
		}
		const snapshot =
			args.sinceSeq === 0 || (doc.latestSnapshotSeq ?? 0) > args.sinceSeq
				? await latestSnapshotForDoc(ctx, args.docId)
				: null;
		const allOps = await ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q: any) => q.eq("docId", args.docId))
			.collect();
		const ops = allOps
			.filter((op: any) => op.seq > args.sinceSeq)
			.sort((a: any, b: any) => a.seq - b.seq)
			.map((op: any) => ({
				seq: op.seq,
				clientId: op.clientId,
				clientSeq: op.clientSeq,
				changeBytes: op.changeBytes,
				timestampMs: op.timestampMs,
			}));
		const binaryHead =
			doc.kind === "binary" && !doc.deletedAtMs
				? await latestBinaryForDoc(ctx, args.docId)
				: null;
		return {
			doc: {
				docId: doc.docId,
				kind: doc.kind,
				path: doc.path,
				latestSeq: doc.latestSeq,
				latestSnapshotSeq: doc.latestSnapshotSeq ?? 0,
				deletedAtMs: doc.deletedAtMs ?? null,
			},
			snapshot:
				snapshot === null
					? null
					: {
						upToSeq: snapshot.upToSeq,
						sizeBytes: snapshot.sizeBytes,
						url: await snapshotUrl(ctx, snapshot.storageId),
					},
			ops,
			binaryHead:
				binaryHead === null
					? null
					: {
						contentHash: binaryHead.contentHash,
						sizeBytes: binaryHead.sizeBytes,
						updatedAtMs: binaryHead.updatedAtMs,
						url: await snapshotUrl(ctx, binaryHead.storageId),
					},
		};
	},
});

export const subscribeDocHead = query({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc) {
			return null;
		}
		return {
			doc: {
				docId: doc.docId,
				kind: doc.kind,
				path: doc.path,
				latestSeq: doc.latestSeq,
				latestSnapshotSeq: doc.latestSnapshotSeq ?? 0,
				deletedAtMs: doc.deletedAtMs ?? null,
			},
		};
	},
});

export const pullDoc = query({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		afterSeq: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc) {
			return null;
		}
		const latestSnapshotSeq = doc.latestSnapshotSeq ?? 0;
		const snapshot =
			args.afterSeq < latestSnapshotSeq ? await latestSnapshotForDoc(ctx, args.docId) : null;
		const opStartSeq = Math.max(args.afterSeq, snapshot?.upToSeq ?? 0);
		const ops = await ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q: any) =>
				q.eq("docId", args.docId).gt("seq", opStartSeq),
			)
			.collect();
		return {
			doc: {
				docId: doc.docId,
				kind: doc.kind,
				path: doc.path,
				latestSeq: doc.latestSeq,
				latestSnapshotSeq,
				deletedAtMs: doc.deletedAtMs ?? null,
			},
			snapshot:
				snapshot === null
					? null
					: {
						upToSeq: snapshot.upToSeq,
						sizeBytes: snapshot.sizeBytes,
						url: await snapshotUrl(ctx, snapshot.storageId),
					},
			ops: ops
				.sort((a: any, b: any) => a.seq - b.seq)
				.map((op: any) => ({
					seq: op.seq,
					clientId: op.clientId,
					clientSeq: op.clientSeq,
					changeBytes: op.changeBytes,
					timestampMs: op.timestampMs,
				})),
		};
	},
});

export const createDoc = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		path: v.string(),
		kind: docKindValidator,
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizeVaultPath(args.path);
		const existing = await getDocByDocId(ctx, args.docId);
		if (existing) {
			return { ok: true as const, docId: existing.docId, created: false as const };
		}
		const now = Date.now();
		await ctx.db.insert("docs", {
			docId: args.docId,
			kind: args.kind,
			path,
			createdAtMs: now,
			createdByClientId: args.clientId,
			updatedAtMs: now,
			updatedByClientId: args.clientId,
			latestSeq: 0,
		});
		return { ok: true as const, docId: args.docId, created: true as const };
	},
});

export const appendOps = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		clientId: v.string(),
		ops: v.array(
			v.object({
				clientSeq: v.number(),
				changeBytes: v.optional(v.bytes()),
				changeBytesBase64: v.optional(v.string()),
				timestampMs: v.number(),
			}),
		),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		if (args.ops.length === 0) {
			return { assignedSeqs: [] };
		}
		if (args.ops.length > MAX_APPEND_OPS) {
			throw new ConvexError(`appendOps accepts at most ${MAX_APPEND_OPS} ops per call.`);
		}
		const ops = args.ops.map((op) => {
			const changeBytes =
				op.changeBytes ??
				(op.changeBytesBase64 ? base64ToArrayBuffer(op.changeBytesBase64) : null);
			if (!changeBytes) {
				throw new ConvexError("appendOps requires changeBytes.");
			}
			return {
				clientSeq: op.clientSeq,
				changeBytes,
				timestampMs: op.timestampMs,
			};
		});
		const payloadBytes = ops.reduce(
			(total, op) => total + op.changeBytes.byteLength,
			0,
		);
		if (payloadBytes > MAX_APPEND_BYTES) {
			throw new ConvexError("appendOps payload is too large.");
		}
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc) {
			throw new ConvexError("unknown doc");
		}
		if (doc.kind !== "text") {
			throw new ConvexError("appendOps only applies to text docs.");
		}
		let seq = doc.latestSeq;
		const assignedSeqs: number[] = [];
		for (const op of ops) {
			const dup = await ctx.db
				.query("docOps")
				.withIndex("by_client_seq", (q: any) =>
					q
						.eq("docId", args.docId)
						.eq("clientId", args.clientId)
						.eq("clientSeq", op.clientSeq),
				)
				.unique();
			if (dup) {
				assignedSeqs.push(dup.seq);
				continue;
			}
			seq += 1;
			await ctx.db.insert("docOps", {
				docId: args.docId,
				seq,
				clientId: args.clientId,
				clientSeq: op.clientSeq,
				changeBytes: op.changeBytes,
				timestampMs: op.timestampMs,
			});
			assignedSeqs.push(seq);
		}
		await ctx.db.patch(doc._id, {
			latestSeq: seq,
			updatedAtMs: Date.now(),
			updatedByClientId: args.clientId,
		});
		return { assignedSeqs };
	},
});

export const replaceDocSnapshot = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		clientId: v.string(),
		baseServerSeq: v.number(),
		clientSeqs: v.array(v.number()),
		snapshotStorageId: v.id("_storage"),
		snapshotSizeBytes: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		if (args.clientSeqs.length === 0) {
			await ctx.storage.delete(args.snapshotStorageId);
			return { assignedSeqs: [] };
		}
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc) {
			await ctx.storage.delete(args.snapshotStorageId);
			throw new ConvexError("unknown doc");
		}
		if (doc.kind !== "text") {
			await ctx.storage.delete(args.snapshotStorageId);
			throw new ConvexError("replaceDocSnapshot only applies to text docs.");
		}
		if (doc.latestSeq > args.baseServerSeq) {
			await ctx.storage.delete(args.snapshotStorageId);
			throw new ConvexError("doc advanced before snapshot upload completed.");
		}
		const sortedClientSeqs = [...new Set(args.clientSeqs)].sort((a, b) => a - b);
		const assignedSeqs = sortedClientSeqs.map((_, index) => doc.latestSeq + index + 1);
		const previousSnapshots = await ctx.db
			.query("docSnapshots")
			.withIndex("by_doc_seq", (q: any) => q.eq("docId", args.docId))
			.collect();
		const existingOps = await ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q: any) => q.eq("docId", args.docId))
			.collect();
		for (const op of existingOps) {
			await ctx.db.delete(op._id);
		}
		for (const snapshot of previousSnapshots) {
			await ctx.storage.delete(snapshot.storageId);
			await ctx.db.delete(snapshot._id);
		}
		await ctx.db.insert("docSnapshots", {
			docId: args.docId,
			upToSeq: assignedSeqs[assignedSeqs.length - 1] ?? doc.latestSeq,
			storageId: args.snapshotStorageId,
			sizeBytes: args.snapshotSizeBytes,
			createdAtMs: Date.now(),
		});
		await ctx.db.patch(doc._id, {
			latestSeq: assignedSeqs[assignedSeqs.length - 1] ?? doc.latestSeq,
			latestSnapshotId: args.snapshotStorageId,
			latestSnapshotSeq: assignedSeqs[assignedSeqs.length - 1] ?? doc.latestSeq,
			latestSnapshotAtMs: Date.now(),
			updatedAtMs: Date.now(),
			updatedByClientId: args.clientId,
			deletedAtMs: undefined,
		});
		return { assignedSeqs };
	},
});

export const moveDoc = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		newPath: v.string(),
		timestampMs: v.number(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc) {
			throw new ConvexError("unknown doc");
		}
		await ctx.db.patch(doc._id, {
			path: normalizeVaultPath(args.newPath),
			updatedAtMs: args.timestampMs,
			updatedByClientId: args.clientId,
		});
		const trash = await getTrashRowByDocId(ctx, args.docId);
		if (trash) {
			await ctx.db.patch(trash._id, {
				originalPath: normalizeVaultPath(args.newPath),
			});
		}
		return { ok: true as const };
	},
});

export const deleteDoc = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		frozenStorageId: v.optional(v.id("_storage")),
		timestampMs: v.number(),
		clientId: v.string(),
		trashRetentionDays: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc) {
			throw new ConvexError("unknown doc");
		}
		const frozenStorageId =
			args.frozenStorageId ??
			(doc.kind === "text"
				? doc.latestSnapshotId
				: (await latestBinaryForDoc(ctx, args.docId))?.storageId);
		const expiresAtMs =
			args.timestampMs +
			(args.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS) * 24 * 60 * 60_000;
		const existingTrash = await getTrashRowByDocId(ctx, args.docId);
		if (existingTrash) {
			await ctx.db.patch(existingTrash._id, {
				originalPath: doc.path,
				kind: doc.kind,
				deletedAtMs: args.timestampMs,
				deletedByClientId: args.clientId,
				frozenSnapshotId: frozenStorageId,
				expiresAtMs,
			});
		} else {
			await ctx.db.insert("trashedDocs", {
				docId: args.docId,
				originalPath: doc.path,
				kind: doc.kind,
				deletedAtMs: args.timestampMs,
				deletedByClientId: args.clientId,
				frozenSnapshotId: frozenStorageId,
				expiresAtMs,
			});
		}
		await ctx.db.patch(doc._id, {
			deletedAtMs: args.timestampMs,
			updatedAtMs: args.timestampMs,
			updatedByClientId: args.clientId,
		});
		return { ok: true as const };
	},
});

export const putBinaryVersion = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		sizeBytes: v.number(),
		updatedAtMs: v.number(),
		clientId: v.string(),
		retentionCount: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc) {
			throw new ConvexError("unknown doc");
		}
		if (doc.kind !== "binary") {
			throw new ConvexError("putBinaryVersion only applies to binary docs.");
		}
		await ctx.db.insert("binaryVersions", {
			docId: args.docId,
			storageId: args.storageId,
			contentHash: args.contentHash,
			sizeBytes: args.sizeBytes,
			updatedAtMs: args.updatedAtMs,
			updatedByClientId: args.clientId,
		});
		await ctx.db.patch(doc._id, {
			updatedAtMs: args.updatedAtMs,
			updatedByClientId: args.clientId,
			deletedAtMs: undefined,
		});
		const keep = Math.max(1, args.retentionCount ?? DEFAULT_BINARY_RETENTION);
		const versions = await ctx.db
			.query("binaryVersions")
			.withIndex("by_doc_time", (q: any) => q.eq("docId", args.docId))
			.order("desc")
			.collect();
		for (const displaced of versions.slice(keep)) {
			await ctx.storage.delete(displaced.storageId);
			await ctx.db.delete(displaced._id);
		}
		return { ok: true as const };
	},
});

export const restoreFromTrash = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const doc = await getDocByDocId(ctx, args.docId);
		const trash = await getTrashRowByDocId(ctx, args.docId);
		if (!doc || !trash) {
			throw new ConvexError("trashed doc not found");
		}
		await ctx.db.patch(doc._id, {
			path: trash.originalPath,
			deletedAtMs: undefined,
			updatedAtMs: Date.now(),
			updatedByClientId: args.clientId,
		});
		await ctx.db.delete(trash._id);
		return { ok: true as const };
	},
});

export const listCompactionCandidates = internalQuery({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const docs = await ctx.db.query("docs").collect();
		return docs
			.filter((doc: any) => {
				if (doc.kind !== "text" || doc.deletedAtMs) {
					return false;
				}
				const latestSnapshotSeq = doc.latestSnapshotSeq ?? 0;
				const latestSnapshotAtMs = doc.latestSnapshotAtMs ?? 0;
				return (
					doc.latestSeq - latestSnapshotSeq >= COMPACTION_OP_THRESHOLD ||
					now - latestSnapshotAtMs >= COMPACTION_AGE_MS
				);
			})
			.sort((a: any, b: any) => b.latestSeq - a.latestSeq)
			.slice(0, HOT_DOC_LIMIT)
			.map((doc: any) => doc.docId);
	},
});

export const getCompactionPayload = internalQuery({
	args: { docId: v.string() },
	handler: async (ctx, args) => {
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc || doc.kind !== "text" || doc.deletedAtMs) {
			return null;
		}
		const snapshot = await latestSnapshotForDoc(ctx, args.docId);
		const ops = await ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q: any) => q.eq("docId", args.docId))
			.collect();
		return {
			doc: {
				docId: doc.docId,
				latestSeq: doc.latestSeq,
			},
			snapshot:
				snapshot === null
					? null
					: {
						storageId: snapshot.storageId,
						upToSeq: snapshot.upToSeq,
					},
			ops: ops
				.filter((op: any) => op.seq > (snapshot?.upToSeq ?? 0))
				.sort((a: any, b: any) => a.seq - b.seq)
				.map((op: any) => ({ seq: op.seq, changeBytes: op.changeBytes })),
		};
	},
});

export const finalizeCompaction = internalMutation({
	args: {
		docId: v.string(),
		upToSeq: v.number(),
		storageId: v.id("_storage"),
		sizeBytes: v.number(),
		createdAtMs: v.number(),
	},
	handler: async (ctx, args) => {
		const doc = await getDocByDocId(ctx, args.docId);
		if (!doc || doc.kind !== "text") {
			await ctx.storage.delete(args.storageId);
			return { ok: false as const };
		}
		const existingSnapshots = await ctx.db
			.query("docSnapshots")
			.withIndex("by_doc_seq", (q: any) => q.eq("docId", args.docId))
			.collect();
		await ctx.db.insert("docSnapshots", {
			docId: args.docId,
			upToSeq: args.upToSeq,
			storageId: args.storageId,
			sizeBytes: args.sizeBytes,
			createdAtMs: args.createdAtMs,
		});
		await ctx.db.patch(doc._id, {
			latestSnapshotId: args.storageId,
			latestSnapshotSeq: args.upToSeq,
			latestSnapshotAtMs: args.createdAtMs,
		});
		const staleOps = await ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q: any) => q.eq("docId", args.docId))
			.collect();
		for (const op of staleOps) {
			if (op.seq <= args.upToSeq) {
				await ctx.db.delete(op._id);
			}
		}
		for (const snapshot of existingSnapshots) {
			await ctx.storage.delete(snapshot.storageId);
			await ctx.db.delete(snapshot._id);
		}
		return { ok: true as const };
	},
});

export const compactDoc = internalAction({
	args: { docId: v.string() },
	handler: async (ctx, args) => {
		const payload = await ctx.runQuery(internal.sync.getCompactionPayload, {
			docId: args.docId,
		});
		if (!payload) {
			return { ok: false as const, reason: "not_found" as const };
		}
		if (payload.ops.length === 0 && payload.snapshot) {
			return { ok: true as const, compacted: false as const };
		}
		let doc = initTextDoc();
		if (payload.snapshot?.storageId) {
			const blob = await ctx.storage.get(payload.snapshot.storageId);
			if (blob) {
				doc = Automerge.load<TextDoc>(new Uint8Array(await blob.arrayBuffer()));
			}
		}
		if (payload.ops.length > 0) {
			doc = Automerge.applyChanges(
				doc,
				payload.ops.map((op: any) => toUint8Array(op.changeBytes)),
			)[0];
		}
		const bytes = Automerge.save(doc);
		const storageId = await ctx.storage.store(
			new Blob([bytes], { type: "application/octet-stream" }),
		);
		await ctx.runMutation(internal.sync.finalizeCompaction, {
			docId: args.docId,
			upToSeq: payload.doc.latestSeq,
			storageId,
			sizeBytes: bytes.byteLength,
			createdAtMs: Date.now(),
		});
		return { ok: true as const, compacted: true as const };
	},
});

export const compactHotDocs = internalAction({
	args: {},
	handler: async (ctx): Promise<{ scheduled: number }> => {
		const docIds = (await ctx.runQuery(
			(internal as any).sync.listCompactionCandidates,
			{},
		)) as string[];
		for (const docId of docIds) {
			await ctx.scheduler.runAfter(0, (internal as any).sync.compactDoc, { docId });
		}
		return { scheduled: docIds.length };
	},
});

export const sweepTrash = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const rows = await ctx.db
			.query("trashedDocs")
			.withIndex("by_expiresAtMs", (q: any) => q.lte("expiresAtMs", now))
			.collect();
		for (const row of rows) {
			if (row.frozenSnapshotId) {
				await ctx.storage.delete(row.frozenSnapshotId);
			}
			await ctx.db.delete(row._id);
		}
		return { deleted: rows.length };
	},
});
