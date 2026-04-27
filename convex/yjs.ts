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
	query,
} from "./_generated/server";
import { paginationOptsValidator } from "convex/server";

const UPDATES_TRIM_THRESHOLD = 25;
// Keep chunks comfortably below Convex's large-document warning threshold.
const MAX_UPDATE_CHUNK_BYTES = 256 * 1024;
const MAX_SNAPSHOT_CHUNK_BYTES = 256 * 1024;
const SNAPSHOT_PRUNE_BATCH_SIZE = 16;
const GET_DOC_PAGE_SIZE = 32;

export const init = action({
	args: {
		docId: v.string(),
		stateVector: v.bytes(),
	},
	returns: v.object({
		update: v.bytes(),
		serverStateVector: v.bytes(),
	}),
	handler: async (ctx, args) => {
		const { mergedUpdate, updates } = await getDocData(ctx, args.docId);
		if (updates.length >= UPDATES_TRIM_THRESHOLD) {
			await ctx.scheduler.runAfter(0, internal.yjs._snapshotUpdates, {
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
		docId: v.string(),
		update: v.bytes(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const decoded = Y.decodeUpdate(new Uint8Array(args.update));
		const hasInserts = decoded.structs.length > 0;
		const hasDeletes = decoded.ds.clients.size > 0;
		if (hasInserts || hasDeletes) {
			const chunks = splitUpdateForStorage(args.update);
			if (chunks.length === 1) {
				await ctx.db.insert("yjsUpdates", args);
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
				await ctx.scheduler.runAfter(0, internal.yjs._snapshotUpdates, {
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

export const pull = query({
	args: {
		docId: v.string(),
	},
	returns: v.bytes(),
	handler: async (ctx, args) => {
		// Must match init/getDocData: snapshot compaction can delete all `yjsUpdates` rows
		// while moving state into `yjsSnapshots`; pull-only-updates would return a no-op
		// and leave clients permanently stale relative to the CRDT.
		const [snapshots, updates] = await Promise.all([
			ctx.db
				.query("yjsSnapshots")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.collect(),
			ctx.db
				.query("yjsUpdates")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.collect(),
		]);
		const snapshotBuffers = reconstructLogicalSnapshots(snapshots).map(
			(snapshot) => new Uint8Array(snapshot),
		);
		const merged = Y.mergeUpdates([
			...snapshotBuffers,
			...reconstructLogicalUpdates(updates).map((update) => new Uint8Array(update)),
		]);
		return asArrayBuffer(merged);
	},
});

export const _snapshotUpdates = internalAction({
	args: { docId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const { mergedUpdate, updates } = await getDocData(ctx, args.docId);
		const latestUpdate = updates[updates.length - 1];
		if (!latestUpdate) {
			return null;
		}
		await ctx.runMutation(internal.yjs._createSnapshot, {
			docId: args.docId,
			timestamp: latestUpdate._creationTime,
			data: asArrayBuffer(mergedUpdate),
		});
		return null;
	},
});

export const _createSnapshot = internalMutation({
	args: {
		docId: v.string(),
		timestamp: v.number(),
		data: v.bytes(),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		for (;;) {
			const snapshotBatch = await ctx.db
				.query("yjsSnapshots")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.take(SNAPSHOT_PRUNE_BATCH_SIZE);
			if (snapshotBatch.length === 0) {
				break;
			}
			for (const snapshot of snapshotBatch) {
				await ctx.db.delete(snapshot._id);
			}
			if (snapshotBatch.length < SNAPSHOT_PRUNE_BATCH_SIZE) {
				break;
			}
		}
		const snapshotChunks = splitBytesForStorage(args.data, MAX_SNAPSHOT_CHUNK_BYTES);
		if (snapshotChunks.length === 1) {
			const onlyChunk = snapshotChunks[0];
			if (!onlyChunk) {
				return null;
			}
			await ctx.db.insert("yjsSnapshots", {
				docId: args.docId,
				data: onlyChunk,
			});
		} else {
			const chunkGroupId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
			for (const [chunkIndex, chunk] of snapshotChunks.entries()) {
				await ctx.db.insert("yjsSnapshots", {
					docId: args.docId,
					data: chunk,
					chunkGroupId,
					chunkIndex,
					chunkCount: snapshotChunks.length,
				});
			}
		}

		for (;;) {
			const updateBatch = await ctx.db
				.query("yjsUpdates")
				.withIndex("by_doc_id", (q) =>
					q.eq("docId", args.docId).lte("_creationTime", args.timestamp),
				)
				.take(SNAPSHOT_PRUNE_BATCH_SIZE);
			if (updateBatch.length === 0) {
				break;
			}
			for (const update of updateBatch) {
				await ctx.db.delete(update._id);
			}
			if (updateBatch.length < SNAPSHOT_PRUNE_BATCH_SIZE) {
				break;
			}
		}
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

export const _removeDoc = internalMutation({
	args: { docId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const [updates, snapshots] = await Promise.all([
			ctx.db
				.query("yjsUpdates")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.collect(),
			ctx.db
				.query("yjsSnapshots")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.collect(),
		]);
		for (const row of updates) {
			await ctx.db.delete(row._id);
		}
		for (const snapshot of snapshots) {
			await ctx.db.delete(snapshot._id);
		}
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

export const _removeDocsByPathSuffix = internalMutation({
	args: { path: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const suffix = `::${args.path}`;
		const [updates, snapshots] = await Promise.all([
			ctx.db.query("yjsUpdates").collect(),
			ctx.db.query("yjsSnapshots").collect(),
		]);
		const docIds = new Set<string>();
		for (const row of updates) {
			if (row.docId.endsWith(suffix)) {
				docIds.add(row.docId);
			}
		}
		for (const row of snapshots) {
			if (row.docId.endsWith(suffix)) {
				docIds.add(row.docId);
			}
		}
		for (const docId of docIds) {
			const [docUpdates, docSnapshots] = await Promise.all([
				ctx.db
					.query("yjsUpdates")
					.withIndex("by_doc_id", (q) => q.eq("docId", docId))
					.collect(),
				ctx.db
					.query("yjsSnapshots")
					.withIndex("by_doc_id", (q) => q.eq("docId", docId))
					.collect(),
			]);
			for (const row of docUpdates) {
				await ctx.db.delete(row._id);
			}
			for (const snapshot of docSnapshots) {
				await ctx.db.delete(snapshot._id);
			}
			const dirtyDoc = await ctx.db
				.query("yjsDirtyDocs")
				.withIndex("by_doc_id", (q) => q.eq("docId", docId))
				.unique();
			if (dirtyDoc) {
				await ctx.db.delete(dirtyDoc._id);
			}
		}
		return null;
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

type DocData = { mergedUpdate: Uint8Array; updates: Array<{ _creationTime: number; update: ArrayBuffer }> };
type PaginatedRows<T> = {
	page: T[];
	isDone: boolean;
	continueCursor: string;
};

async function getDocData(
	ctx: Pick<GenericActionCtx<DataModel>, "runQuery">,
	docId: string,
): Promise<DocData> {
	const snapshots: StoredYjsSnapshot[] = [];
	const updates: StoredYjsUpdate[] = [];
	let snapshotCursor: string | null = null;
	let updateCursor: string | null = null;
	let snapshotsDone = false;
	let updatesDone = false;

	while (!snapshotsDone) {
		const page = (await ctx.runQuery(internal.yjs._getSnapshotPage, {
			docId,
			paginationOpts: { cursor: snapshotCursor, numItems: GET_DOC_PAGE_SIZE },
		})) as PaginatedRows<StoredYjsSnapshot>;
		snapshots.push(...page.page);
		snapshotCursor = page.continueCursor;
		snapshotsDone = page.isDone;
	}
	while (!updatesDone) {
		const page = (await ctx.runQuery(internal.yjs._getUpdatePage, {
			docId,
			paginationOpts: { cursor: updateCursor, numItems: GET_DOC_PAGE_SIZE },
		})) as PaginatedRows<StoredYjsUpdate>;
		updates.push(...page.page);
		updateCursor = page.continueCursor;
		updatesDone = page.isDone;
	}

	const snapshotBuffers = reconstructLogicalSnapshots(snapshots).map(
		(snapshot) => new Uint8Array(snapshot),
	);
	const logicalUpdates = reconstructLogicalUpdates(updates);
	const mergedUpdate = Y.mergeUpdates([
		...snapshotBuffers,
		...logicalUpdates.map((update) => new Uint8Array(update)),
	]);
	return { mergedUpdate, updates };
}

type StoredYjsSnapshot = {
	data: ArrayBuffer;
	chunkGroupId?: string;
	chunkIndex?: number;
	chunkCount?: number;
};

function reconstructLogicalSnapshots(snapshots: StoredYjsSnapshot[]): ArrayBuffer[] {
	return reconstructLogicalBytes(snapshots);
}

type StoredYjsUpdate = {
	_creationTime: number;
	update: ArrayBuffer;
	chunkGroupId?: string;
	chunkIndex?: number;
	chunkCount?: number;
};

function reconstructLogicalUpdates(updates: StoredYjsUpdate[]): ArrayBuffer[] {
	return reconstructLogicalBytes(
		updates.map((update) => ({
			data: update.update,
			chunkGroupId: update.chunkGroupId,
			chunkIndex: update.chunkIndex,
			chunkCount: update.chunkCount,
		})),
	);
}

type ChunkedBytesRow = {
	data: ArrayBuffer;
	chunkGroupId?: string;
	chunkIndex?: number;
	chunkCount?: number;
};

function reconstructLogicalBytes(rows: ChunkedBytesRow[]): ArrayBuffer[] {
	const logicalUpdates: ArrayBuffer[] = [];
	const grouped = new Map<string, Map<number, ArrayBuffer>>();
	const expectedChunkCounts = new Map<string, number>();

	for (const row of rows) {
		const { chunkGroupId, chunkIndex, chunkCount } = row;
		if (
			chunkGroupId === undefined ||
			chunkIndex === undefined ||
			chunkCount === undefined
		) {
			logicalUpdates.push(row.data);
			continue;
		}
		let group = grouped.get(chunkGroupId);
		if (!group) {
			group = new Map<number, ArrayBuffer>();
			grouped.set(chunkGroupId, group);
		}
		group.set(chunkIndex, row.data);
		expectedChunkCounts.set(chunkGroupId, chunkCount);
	}

	for (const [chunkGroupId, chunkMap] of grouped) {
		const expectedCount = expectedChunkCounts.get(chunkGroupId);
		if (expectedCount === undefined || chunkMap.size !== expectedCount) {
			// Skip incomplete groups and let a future pull recover once all chunks arrive.
			continue;
		}
		const orderedChunks: Uint8Array[] = [];
		let totalBytes = 0;
		let missingChunk = false;
		for (let i = 0; i < expectedCount; i++) {
			const chunk = chunkMap.get(i);
			if (!chunk) {
				missingChunk = true;
				break;
			}
			const bytes = new Uint8Array(chunk);
			orderedChunks.push(bytes);
			totalBytes += bytes.byteLength;
		}
		if (missingChunk) {
			continue;
		}
		const merged = new Uint8Array(totalBytes);
		let offset = 0;
		for (const chunk of orderedChunks) {
			merged.set(chunk, offset);
			offset += chunk.byteLength;
		}
		logicalUpdates.push(asArrayBuffer(merged));
	}

	return logicalUpdates;
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
	) as ArrayBuffer;
}
