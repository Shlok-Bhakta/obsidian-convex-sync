import type { GenericActionCtx } from "convex/server";
import { v } from "convex/values";
import * as Y from "yjs";
import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
} from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { normalizeVaultPath, upsertTextVaultFile } from "./_lib/vaultFiles";
import { requirePluginSecret } from "./security";

const UPDATES_TRIM_THRESHOLD = 25;
// Keep chunks comfortably below Convex's large-document warning threshold.
const MAX_UPDATE_CHUNK_BYTES = 256 * 1024;
const MAX_SNAPSHOT_CHUNK_BYTES = 256 * 1024;
const SNAPSHOT_PRUNE_BATCH_SIZE = 64;
const DOC_REMOVAL_BATCH_SIZE = 64;
const GET_DOC_PAGE_SIZE = 32;
const GET_DOC_PAGE_MAX_BYTES = 8 * 1024 * 1024;

export const init = action({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		stateVector: v.bytes(),
		/** When true, do not enqueue `_snapshotUpdates` (bootstrap pre-flushes dirty docs; scheduling per file would flood writes). */
		skipCompactionSchedule: v.optional(v.boolean()),
	},
	returns: v.object({
		update: v.bytes(),
		serverStateVector: v.bytes(),
	}),
	handler: async (ctx, args) => {
		await requirePluginSecretForAction(ctx, args.convexSecret);
		const { mergedUpdate, updateRowCount } = await getDocData(ctx, args.docId);
		if (
			!args.skipCompactionSchedule &&
			updateRowCount >= UPDATES_TRIM_THRESHOLD
		) {
			await ctx.scheduler.runAfter(0, internal.yjsSync._snapshotUpdates, {
				docId: args.docId,
			});
		}
		const stateVec = new Uint8Array(args.stateVector);
		const update = Y.diffUpdate(mergedUpdate, stateVec);
		const serverStateVector = Y.encodeStateVectorFromUpdate(mergedUpdate);
		return {
			update: asArrayBuffer(update),
			serverStateVector: asArrayBuffer(serverStateVector),
		};
	},
});

export const push = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		path: v.string(),
		update: v.bytes(),
		contentHash: v.string(),
		sizeBytes: v.number(),
		updatedAtMs: v.number(),
		clientId: v.string(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		await upsertTextVaultFile(ctx, {
			path: normalizeVaultPath(args.path),
			contentHash: args.contentHash,
			sizeBytes: args.sizeBytes,
			updatedAtMs: args.updatedAtMs,
			clientId: args.clientId,
		});
		const decoded = Y.decodeUpdate(new Uint8Array(args.update));
		const hasInserts = decoded.structs.length > 0;
		const hasDeletes = decoded.ds.clients.size > 0;
		if (hasInserts || hasDeletes) {
			const chunks = splitUpdateForStorage(args.update);
			if (chunks.length === 1) {
				await ctx.db.insert("yjsUpdates", {
					docId: args.docId,
					update: args.update,
				});
			} else {
				const chunkGroupId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
				for (const [chunkIndex, chunk] of chunks.entries()) {
					await ctx.db.insert("yjsUpdates", {
						docId: args.docId,
						update: chunk,
						chunkGroupId,
						chunkIndex,
						chunkCount: chunks.length,
					});
				}
			}
			// Keep update backlog bounded under heavy typing bursts so pull stays fast.
			const recentBatch = await ctx.db
				.query("yjsUpdates")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.order("desc")
				.take(UPDATES_TRIM_THRESHOLD);
			if (recentBatch.length >= UPDATES_TRIM_THRESHOLD) {
				await ctx.scheduler.runAfter(0, internal.yjsSync._snapshotUpdates, {
					docId: args.docId,
				});
			}
			const dirtyDoc = await ctx.db
				.query("yjsDirtyDocs")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.unique();
			if (!dirtyDoc) {
				await ctx.db.insert("yjsDirtyDocs", { docId: args.docId });
			}
		}
		return null;
	},
});

export const pull = action({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
	},
	returns: v.bytes(),
	handler: async (ctx, args) => {
		await requirePluginSecretForAction(ctx, args.convexSecret);
		const { mergedUpdate } = await getDocData(ctx, args.docId);
		return asArrayBuffer(mergedUpdate);
	},
});

/** Spreads DB writes so bootstrap / compaction stays under Convex write-rate limits. */
function writeThrottleMs(): number {
	return 75;
}

async function sleepMs(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

export const _snapshotUpdates = internalAction({
	args: { docId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const { mergedUpdate, updateRowCount, lastUpdateCreationTime } = await getDocData(ctx, args.docId);
		if (updateRowCount === 0) {
			return null;
		}
		const timestamp = lastUpdateCreationTime;
		const throttle = writeThrottleMs();

		let moreSnapshots = true;
		while (moreSnapshots) {
			moreSnapshots = await ctx.runMutation(internal.yjsSync._pruneOldSnapshotsOnce, {
				docId: args.docId,
			});
			if (moreSnapshots) {
				await sleepMs(throttle);
			}
		}

		const snapshotChunks = splitBytesForStorage(
			asArrayBuffer(mergedUpdate),
			MAX_SNAPSHOT_CHUNK_BYTES,
		);
		if (snapshotChunks.length === 1) {
			const onlyChunk = snapshotChunks[0];
			if (!onlyChunk) {
				return null;
			}
			await ctx.runMutation(internal.yjsSync._insertSnapshotChunk, {
				docId: args.docId,
				data: onlyChunk,
			});
		} else {
			const chunkGroupId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			for (const [chunkIndex, chunk] of snapshotChunks.entries()) {
				await ctx.runMutation(internal.yjsSync._insertSnapshotChunk, {
					docId: args.docId,
					data: chunk,
					chunkGroupId,
					chunkIndex,
					chunkCount: snapshotChunks.length,
				});
				if (chunkIndex + 1 < snapshotChunks.length) {
					await sleepMs(throttle);
				}
			}
		}

		let moreUpdates = true;
		while (moreUpdates) {
			moreUpdates = await ctx.runMutation(internal.yjsSync._pruneOldUpdatesOnce, {
				docId: args.docId,
				timestamp,
			});
			if (moreUpdates) {
				await sleepMs(throttle);
			}
		}

		await ctx.runMutation(internal.yjsSync._markDocClean, { docId: args.docId });
		return null;
	},
});

export const _pruneOldSnapshotsOnce = internalMutation({
	args: { docId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query("yjsSnapshots")
			.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
			.take(SNAPSHOT_PRUNE_BATCH_SIZE);
		for (const row of batch) {
			await ctx.db.delete(row._id);
		}
		return batch.length === SNAPSHOT_PRUNE_BATCH_SIZE;
	},
});

export const _pruneOldUpdatesOnce = internalMutation({
	args: {
		docId: v.string(),
		timestamp: v.number(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query("yjsUpdates")
			.withIndex("by_doc_id", (q) =>
				q.eq("docId", args.docId).lte("_creationTime", args.timestamp),
			)
			.take(SNAPSHOT_PRUNE_BATCH_SIZE);
		for (const row of batch) {
			await ctx.db.delete(row._id);
		}
		return batch.length === SNAPSHOT_PRUNE_BATCH_SIZE;
	},
});

export const _insertSnapshotChunk = internalMutation({
	args: {
		docId: v.string(),
		data: v.bytes(),
		chunkGroupId: v.optional(v.string()),
		chunkIndex: v.optional(v.number()),
		chunkCount: v.optional(v.number()),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		await ctx.db.insert("yjsSnapshots", {
			docId: args.docId,
			data: args.data,
			chunkGroupId: args.chunkGroupId,
			chunkIndex: args.chunkIndex,
			chunkCount: args.chunkCount,
		});
		return null;
	},
});

export const _markDocClean = internalMutation({
	args: { docId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const dirtyDoc = await ctx.db
			.query("yjsDirtyDocs")
			.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
			.unique();
		if (dirtyDoc) {
			await ctx.db.delete(dirtyDoc._id);
		}
		return null;
	},
});

export const _listDocIdsWithPendingUpdates = internalQuery({
	args: {},
	returns: v.array(v.string()),
	handler: async (ctx) => {
		const dirtyDocs = await ctx.db.query("yjsDirtyDocs").collect();
		return dirtyDocs.map((row) => row.docId);
	},
});

export const _removeDoc = internalAction({
	args: { docId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		await removeDocRows(ctx, args.docId);
		return null;
	},
});

export const _removeDocsByPathSuffix = internalAction({
	args: { path: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const suffix = `::${args.path}`;
		for (const source of ["updates", "snapshots"] as const) {
			let cursor: string | null = null;
			let isDone = false;
			while (!isDone) {
				const page = (await ctx.runQuery(internal.yjsSync._listDocIdsBySuffixPage, {
					suffix,
					source,
					paginationOpts: {
						cursor,
						numItems: DOC_REMOVAL_BATCH_SIZE,
						maximumBytesRead: GET_DOC_PAGE_MAX_BYTES,
					},
				})) as PaginatedRows<{ docId: string }>;
				const docIds = new Set(page.page.map((row) => row.docId));
				for (const docId of docIds) {
					await removeDocRows(ctx, docId);
				}
				cursor = page.continueCursor;
				isDone = page.isDone;
			}
		}
		return null;
	},
});

export const _deleteUpdateRowsOnce = internalMutation({
	args: { docId: v.string(), timestamp: v.optional(v.number()) },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query("yjsUpdates")
			.withIndex("by_doc_id", (q) => {
				const docQuery = q.eq("docId", args.docId);
				return args.timestamp === undefined
					? docQuery
					: docQuery.lte("_creationTime", args.timestamp);
			})
			.take(SNAPSHOT_PRUNE_BATCH_SIZE);
		for (const row of batch) {
			await ctx.db.delete(row._id);
		}
		return batch.length === SNAPSHOT_PRUNE_BATCH_SIZE;
	},
});

export const _listDocIdsBySuffixPage = internalQuery({
	args: {
		suffix: v.string(),
		source: v.union(v.literal("updates"), v.literal("snapshots")),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		const rows = await (args.source === "updates"
			? ctx.db.query("yjsUpdates")
			: ctx.db.query("yjsSnapshots")
		).paginate(args.paginationOpts);
		return {
			...rows,
			page: rows.page
				.filter((row) => row.docId.endsWith(args.suffix))
				.map((row) => ({ docId: row.docId })),
		};
	},
});

export const _getSnapshotPage = internalQuery({
	args: { docId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("yjsSnapshots")
			.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
			.paginate(args.paginationOpts);
	},
});

export const _getUpdatePage = internalQuery({
	args: { docId: v.string(), paginationOpts: paginationOptsValidator },
	handler: async (ctx, args) => {
		return await ctx.db
			.query("yjsUpdates")
			.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
			.paginate(args.paginationOpts);
	},
});

type DocData = {
	mergedUpdate: Uint8Array;
	updateRowCount: number;
	/** `_creationTime` of the last yjsUpdates row seen while paginating (same basis as the old `updates.at(-1)`). */
	lastUpdateCreationTime: number;
};

type StoredYjsSnapshot = {
	data: ArrayBuffer;
	chunkGroupId?: string;
	chunkIndex?: number;
	chunkCount?: number;
};

type StoredYjsUpdate = {
	_creationTime: number;
	update: ArrayBuffer;
	chunkGroupId?: string;
	chunkIndex?: number;
	chunkCount?: number;
};

type PaginatedRows<T> = {
	page: T[];
	isDone: boolean;
	continueCursor: string;
};

type ChunkedBytesRow = {
	data: ArrayBuffer;
	chunkGroupId?: string;
	chunkIndex?: number;
	chunkCount?: number;
};

/** Matches `reconstructLogicalBytes` ordering: all non-chunked rows in iteration order, then completed chunk groups in first-seen group order. */
type LogicalStreamAcc = {
	grouped: Map<string, Map<number, ArrayBuffer>>;
	expectedChunkCounts: Map<string, number>;
	chunkGroupOrder: string[];
	nonChunked: ArrayBuffer[];
	completedChunks: Map<string, ArrayBuffer>;
};

function emptyLogicalStreamAcc(): LogicalStreamAcc {
	return {
		grouped: new Map(),
		expectedChunkCounts: new Map(),
		chunkGroupOrder: [],
		nonChunked: [],
		completedChunks: new Map(),
	};
}

function feedLogicalStreamRow(acc: LogicalStreamAcc, row: ChunkedBytesRow): void {
	const { data, chunkGroupId, chunkIndex, chunkCount } = row;
	if (
		chunkGroupId === undefined ||
		chunkIndex === undefined ||
		chunkCount === undefined
	) {
		acc.nonChunked.push(data);
		return;
	}
	let group = acc.grouped.get(chunkGroupId);
	if (!group) {
		group = new Map<number, ArrayBuffer>();
		acc.grouped.set(chunkGroupId, group);
		acc.chunkGroupOrder.push(chunkGroupId);
	}
	group.set(chunkIndex, data);
	acc.expectedChunkCounts.set(chunkGroupId, chunkCount);
	if (group.size !== chunkCount) {
		return;
	}
	const orderedChunks: Uint8Array[] = [];
	let totalBytes = 0;
	let missingChunk = false;
	for (let i = 0; i < chunkCount; i++) {
		const chunk = group.get(i);
		if (!chunk) {
			missingChunk = true;
			break;
		}
		const bytes = new Uint8Array(chunk);
		orderedChunks.push(bytes);
		totalBytes += bytes.byteLength;
	}
	if (missingChunk) {
		return;
	}
	const merged = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of orderedChunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	acc.completedChunks.set(chunkGroupId, asArrayBuffer(merged));
	acc.grouped.delete(chunkGroupId);
	acc.expectedChunkCounts.delete(chunkGroupId);
}

function applyLogicalStreamAccToYDoc(doc: Y.Doc, acc: LogicalStreamAcc): void {
	for (const buf of acc.nonChunked) {
		Y.applyUpdate(doc, new Uint8Array(buf));
	}
	for (const gid of acc.chunkGroupOrder) {
		const buf = acc.completedChunks.get(gid);
		if (buf) {
			Y.applyUpdate(doc, new Uint8Array(buf));
		}
	}
}

async function getDocData(
	ctx: Pick<GenericActionCtx<DataModel>, "runQuery">,
	docId: string,
): Promise<DocData> {
	const doc = new Y.Doc();
	const snapshotAcc = emptyLogicalStreamAcc();
	let snapshotCursor: string | null = null;
	let snapshotsDone = false;

	while (!snapshotsDone) {
		const page = (await ctx.runQuery(internal.yjsSync._getSnapshotPage, {
			docId,
			paginationOpts: {
				cursor: snapshotCursor,
				numItems: GET_DOC_PAGE_SIZE,
				maximumBytesRead: GET_DOC_PAGE_MAX_BYTES,
			},
		})) as PaginatedRows<StoredYjsSnapshot>;
		for (const row of page.page) {
			feedLogicalStreamRow(snapshotAcc, {
				data: row.data,
				chunkGroupId: row.chunkGroupId,
				chunkIndex: row.chunkIndex,
				chunkCount: row.chunkCount,
			});
		}
		snapshotCursor = page.continueCursor;
		snapshotsDone = page.isDone;
	}
	applyLogicalStreamAccToYDoc(doc, snapshotAcc);

	const updateAcc = emptyLogicalStreamAcc();
	let updateRowCount = 0;
	let lastUpdateCreationTime = 0;
	let updateCursor: string | null = null;
	let updatesDone = false;

	while (!updatesDone) {
		const page = (await ctx.runQuery(internal.yjsSync._getUpdatePage, {
			docId,
			paginationOpts: {
				cursor: updateCursor,
				numItems: GET_DOC_PAGE_SIZE,
				maximumBytesRead: GET_DOC_PAGE_MAX_BYTES,
			},
		})) as PaginatedRows<StoredYjsUpdate>;
		for (const row of page.page) {
			updateRowCount += 1;
			lastUpdateCreationTime = row._creationTime;
			feedLogicalStreamRow(updateAcc, {
				data: row.update,
				chunkGroupId: row.chunkGroupId,
				chunkIndex: row.chunkIndex,
				chunkCount: row.chunkCount,
			});
		}
		updateCursor = page.continueCursor;
		updatesDone = page.isDone;
	}
	applyLogicalStreamAccToYDoc(doc, updateAcc);

	const mergedUpdate = Y.encodeStateAsUpdate(doc);
	doc.destroy();

	return { mergedUpdate, updateRowCount, lastUpdateCreationTime };
}

async function removeDocRows(
	ctx: Pick<GenericActionCtx<DataModel>, "runMutation">,
	docId: string,
): Promise<void> {
	let moreSnapshots = true;
	while (moreSnapshots) {
		moreSnapshots = await ctx.runMutation(internal.yjsSync._pruneOldSnapshotsOnce, { docId });
	}
	let moreUpdates = true;
	while (moreUpdates) {
		moreUpdates = await ctx.runMutation(internal.yjsSync._deleteUpdateRowsOnce, { docId });
	}
	await ctx.runMutation(internal.yjsSync._markDocClean, { docId });
}

function splitUpdateForStorage(update: ArrayBuffer): ArrayBuffer[] {
	return splitBytesForStorage(update, MAX_UPDATE_CHUNK_BYTES);
}

function splitBytesForStorage(bytesBuffer: ArrayBuffer, chunkBytes: number): ArrayBuffer[] {
	const bytes = new Uint8Array(bytesBuffer);
	if (bytes.byteLength <= chunkBytes) {
		return [bytesBuffer];
	}
	const chunks: ArrayBuffer[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
		const end = Math.min(offset + chunkBytes, bytes.byteLength);
		chunks.push(asArrayBuffer(bytes.slice(offset, end)));
	}
	return chunks;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
}

async function requirePluginSecretForAction(
	ctx: Pick<GenericActionCtx<DataModel>, "runQuery">,
	secret: string,
): Promise<void> {
	const auth = await ctx.runQuery(internal.security.validatePluginSecret, {
		secret,
	});
	if (!auth.ok) {
		throw new Error("The vault API key is invalid for this Convex deployment.");
	}
}
