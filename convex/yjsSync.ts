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
import type { MutationCtx } from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { normalizeVaultPath, upsertTextVaultFile } from "./_lib/vaultFiles";
import { requirePluginSecret } from "./security";

const UPDATES_TRIM_THRESHOLD = 25;
// Keep chunks comfortably below Convex's large-document warning threshold.
const MAX_UPDATE_CHUNK_BYTES = 256 * 1024;
const MAX_SNAPSHOT_CHUNK_BYTES = 256 * 1024;
const COMPACTION_DELETE_BATCH_SIZE = 4;
const COMPACTION_REQUEST_STALE_MS = 2 * 60_000;
const WRITE_THROTTLE_BYTES_PER_SECOND = 1.5 * 1024 * 1024;
const DOC_REMOVAL_BATCH_SIZE = 64;
const GET_DOC_PAGE_SIZE = 32;
const GET_DOC_PAGE_MAX_BYTES = 1 * 1024 * 1024;

export const init = action({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		stateVector: v.bytes(),
	},
	returns: v.object({
		update: v.bytes(),
		serverStateVector: v.bytes(),
	}),
	handler: async (ctx, args) => {
		await requirePluginSecretForAction(ctx, args.convexSecret);
		const { mergedUpdate, updateRowCount } = await getDocData(ctx, args.docId);
		if (updateRowCount >= UPDATES_TRIM_THRESHOLD) {
			const scheduled = await ctx.runMutation(internal.yjsSync._requestCompaction, {
				docId: args.docId,
				nowMs: Date.now(),
			});
			if (scheduled) {
				await ctx.scheduler.runAfter(0, internal.yjsSync._snapshotUpdates, {
					docId: args.docId,
				});
			}
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
			const dirtyDoc = await ctx.db
				.query("yjsDirtyDocs")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.unique();
			if (dirtyDoc) {
				await ctx.db.patch(dirtyDoc._id, { updatedAtMs: args.updatedAtMs });
			} else {
				await ctx.db.insert("yjsDirtyDocs", {
					docId: args.docId,
					updatedAtMs: args.updatedAtMs,
				});
			}
			// Keep update backlog bounded, but only allow one queued compaction per doc.
			const recentBatch = await ctx.db
				.query("yjsUpdates")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.order("desc")
				.take(UPDATES_TRIM_THRESHOLD);
			if (recentBatch.length >= UPDATES_TRIM_THRESHOLD) {
				const scheduled = await requestCompaction(ctx, args.docId, Date.now());
				if (scheduled) {
					await ctx.scheduler.runAfter(0, internal.yjsSync._snapshotUpdates, {
						docId: args.docId,
					});
				}
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

export const _readTextForBootstrap = internalAction({
	args: { docId: v.string() },
	returns: v.string(),
	handler: async (ctx, args) => {
		const { mergedUpdate } = await getDocData(ctx, args.docId);
		const doc = new Y.Doc();
		try {
			if (mergedUpdate.byteLength > 0) {
				Y.applyUpdate(doc, mergedUpdate);
			}
			return doc.getText("content").toJSON();
		} finally {
			doc.destroy();
		}
	},
});

type CompactionBatchResult = {
	more: boolean;
	rows: number;
	bytesWritten: number;
};

/** Spreads DB writes so compaction stays below Convex deployment write-rate limits. */
function writeThrottleMs(bytesWritten: number): number {
	if (bytesWritten <= 0) {
		return 0;
	}
	return Math.ceil((bytesWritten / WRITE_THROTTLE_BYTES_PER_SECOND) * 1000);
}

async function sleepMs(ms: number): Promise<void> {
	if (ms <= 0) {
		return;
	}
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepAfterWriteBytes(bytesWritten: number): Promise<void> {
	await sleepMs(writeThrottleMs(bytesWritten));
}

async function requestCompaction(
	ctx: MutationCtx,
	docId: string,
	nowMs: number,
): Promise<boolean> {
	const dirtyDoc = await ctx.db
		.query("yjsDirtyDocs")
		.withIndex("by_doc_id", (q) => q.eq("docId", docId))
		.unique();
	if (!dirtyDoc) {
		await ctx.db.insert("yjsDirtyDocs", {
			docId,
			updatedAtMs: nowMs,
			compactionRequestedAtMs: nowMs,
		});
		return true;
	}
	const requestedAt = dirtyDoc.compactionRequestedAtMs;
	if (
		typeof requestedAt === "number" &&
		nowMs - requestedAt < COMPACTION_REQUEST_STALE_MS
	) {
		return false;
	}
	await ctx.db.patch(dirtyDoc._id, {
		updatedAtMs: dirtyDoc.updatedAtMs ?? nowMs,
		compactionRequestedAtMs: nowMs,
	});
	return true;
}

export const _requestCompaction = internalMutation({
	args: {
		docId: v.string(),
		nowMs: v.number(),
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		return await requestCompaction(ctx, args.docId, args.nowMs);
	},
});

export const _snapshotUpdates = internalAction({
	args: { docId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const { mergedUpdate, updateRowCount, lastUpdateCreationTime } = await getDocData(ctx, args.docId);
		if (updateRowCount === 0) {
			await ctx.runMutation(internal.yjsSync._markCompactionComplete, {
				docId: args.docId,
				compactedThroughCreationTime: 0,
				nowMs: Date.now(),
			});
			return null;
		}
		const timestamp = lastUpdateCreationTime;

		let moreSnapshots = true;
		while (moreSnapshots) {
			const result = (await ctx.runMutation(internal.yjsSync._pruneOldSnapshotsOnce, {
				docId: args.docId,
			})) as CompactionBatchResult;
			moreSnapshots = result.more;
			await sleepAfterWriteBytes(result.bytesWritten);
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
			await sleepAfterWriteBytes(onlyChunk.byteLength);
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
				await sleepAfterWriteBytes(chunk.byteLength);
			}
		}

		let moreUpdates = true;
		while (moreUpdates) {
			const result = (await ctx.runMutation(internal.yjsSync._pruneOldUpdatesOnce, {
				docId: args.docId,
				timestamp,
			})) as CompactionBatchResult;
			moreUpdates = result.more;
			await sleepAfterWriteBytes(result.bytesWritten);
		}

		const complete = (await ctx.runMutation(internal.yjsSync._markCompactionComplete, {
			docId: args.docId,
			compactedThroughCreationTime: timestamp,
			nowMs: Date.now(),
		})) as { shouldReschedule: boolean };
		if (complete.shouldReschedule) {
			await ctx.scheduler.runAfter(0, internal.yjsSync._snapshotUpdates, {
				docId: args.docId,
			});
		}
		return null;
	},
});

export const _pruneOldSnapshotsOnce = internalMutation({
	args: { docId: v.string() },
	returns: v.object({
		more: v.boolean(),
		rows: v.number(),
		bytesWritten: v.number(),
	}),
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query("yjsSnapshots")
			.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
			.take(COMPACTION_DELETE_BATCH_SIZE);
		let bytesWritten = 0;
		for (const row of batch) {
			bytesWritten += row.data.byteLength;
			await ctx.db.delete(row._id);
		}
		return {
			more: batch.length === COMPACTION_DELETE_BATCH_SIZE,
			rows: batch.length,
			bytesWritten,
		};
	},
});

export const _pruneOldUpdatesOnce = internalMutation({
	args: {
		docId: v.string(),
		timestamp: v.number(),
	},
	returns: v.object({
		more: v.boolean(),
		rows: v.number(),
		bytesWritten: v.number(),
	}),
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query("yjsUpdates")
			.withIndex("by_doc_id", (q) =>
				q.eq("docId", args.docId).lte("_creationTime", args.timestamp),
			)
			.take(COMPACTION_DELETE_BATCH_SIZE);
		let bytesWritten = 0;
		for (const row of batch) {
			bytesWritten += row.update.byteLength;
			await ctx.db.delete(row._id);
		}
		return {
			more: batch.length === COMPACTION_DELETE_BATCH_SIZE,
			rows: batch.length,
			bytesWritten,
		};
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

export const _markCompactionComplete = internalMutation({
	args: {
		docId: v.string(),
		compactedThroughCreationTime: v.number(),
		nowMs: v.number(),
	},
	returns: v.object({ shouldReschedule: v.boolean() }),
	handler: async (ctx, args) => {
		const remainingUpdates = await ctx.db
			.query("yjsUpdates")
			.withIndex("by_doc_id", (q) =>
				q.eq("docId", args.docId).gt("_creationTime", args.compactedThroughCreationTime),
			)
			.take(UPDATES_TRIM_THRESHOLD);
		const dirtyDoc = await ctx.db
			.query("yjsDirtyDocs")
			.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
			.unique();
		if (remainingUpdates.length === 0) {
			if (dirtyDoc) {
				await ctx.db.delete(dirtyDoc._id);
			}
			return { shouldReschedule: false };
		}
		const shouldReschedule = remainingUpdates.length >= UPDATES_TRIM_THRESHOLD;
		const patch = {
			updatedAtMs: args.nowMs,
			compactionRequestedAtMs: shouldReschedule ? args.nowMs : undefined,
		};
		if (dirtyDoc) {
			await ctx.db.patch(dirtyDoc._id, patch);
		} else {
			await ctx.db.insert("yjsDirtyDocs", {
				docId: args.docId,
				...patch,
			});
		}
		return { shouldReschedule };
	},
});

export const _listDocIdsWithPendingUpdates = internalQuery({
	args: { limit: v.optional(v.number()) },
	returns: v.array(v.string()),
	handler: async (ctx, args) => {
		const dirtyDocs = await ctx.db
			.query("yjsDirtyDocs")
			.take(Math.min(Math.max(args.limit ?? 100, 1), 500));
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
	returns: v.object({
		more: v.boolean(),
		rows: v.number(),
		bytesWritten: v.number(),
	}),
	handler: async (ctx, args) => {
		const batch = await ctx.db
			.query("yjsUpdates")
			.withIndex("by_doc_id", (q) => {
				const docQuery = q.eq("docId", args.docId);
				return args.timestamp === undefined
					? docQuery
					: docQuery.lte("_creationTime", args.timestamp);
			})
			.take(COMPACTION_DELETE_BATCH_SIZE);
		let bytesWritten = 0;
		for (const row of batch) {
			bytesWritten += row.update.byteLength;
			await ctx.db.delete(row._id);
		}
		return {
			more: batch.length === COMPACTION_DELETE_BATCH_SIZE,
			rows: batch.length,
			bytesWritten,
		};
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

type LogicalStreamAcc = {
	grouped: Map<string, Map<number, ArrayBuffer>>;
	expectedChunkCounts: Map<string, number>;
};

function emptyLogicalStreamAcc(): LogicalStreamAcc {
	return {
		grouped: new Map(),
		expectedChunkCounts: new Map(),
	};
}

function feedLogicalStreamRow(doc: Y.Doc, acc: LogicalStreamAcc, row: ChunkedBytesRow): void {
	const { data, chunkGroupId, chunkIndex, chunkCount } = row;
	if (
		chunkGroupId === undefined ||
		chunkIndex === undefined ||
		chunkCount === undefined
	) {
		Y.applyUpdate(doc, new Uint8Array(data));
		return;
	}
	let group = acc.grouped.get(chunkGroupId);
	if (!group) {
		group = new Map<number, ArrayBuffer>();
		acc.grouped.set(chunkGroupId, group);
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
	Y.applyUpdate(doc, merged);
	acc.grouped.delete(chunkGroupId);
	acc.expectedChunkCounts.delete(chunkGroupId);
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
			feedLogicalStreamRow(doc, snapshotAcc, {
				data: row.data,
				chunkGroupId: row.chunkGroupId,
				chunkIndex: row.chunkIndex,
				chunkCount: row.chunkCount,
			});
		}
		snapshotCursor = page.continueCursor;
		snapshotsDone = page.isDone;
	}

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
			feedLogicalStreamRow(doc, updateAcc, {
				data: row.update,
				chunkGroupId: row.chunkGroupId,
				chunkIndex: row.chunkIndex,
				chunkCount: row.chunkCount,
			});
		}
		updateCursor = page.continueCursor;
		updatesDone = page.isDone;
	}

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
		const result = (await ctx.runMutation(internal.yjsSync._pruneOldSnapshotsOnce, {
			docId,
		})) as CompactionBatchResult;
		moreSnapshots = result.more;
		await sleepAfterWriteBytes(result.bytesWritten);
	}
	let moreUpdates = true;
	while (moreUpdates) {
		const result = (await ctx.runMutation(internal.yjsSync._deleteUpdateRowsOnce, {
			docId,
		})) as CompactionBatchResult;
		moreUpdates = result.more;
		await sleepAfterWriteBytes(result.bytesWritten);
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
