import { v } from "convex/values";
import * as Y from "yjs";
import { internal } from "./_generated/api";
import {
	action,
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";

const UPDATES_TRIM_THRESHOLD = 25;
const MAX_UPDATE_CHUNK_BYTES = 900 * 1024;

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
		// Pull must not truncate to a fixed batch size; subscribers need every
		// outstanding update since their last state to avoid CRDT divergence.
		const updates = await ctx.db
			.query("yjsUpdates")
			.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
			.collect();
		const merged = Y.mergeUpdates(
			reconstructLogicalUpdates(updates).map((update) => new Uint8Array(update)),
		);
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
		const fileId = await ctx.storage.store(new Blob([asArrayBuffer(mergedUpdate)]));
		try {
			await ctx.runMutation(internal.yjs._createSnapshot, {
				docId: args.docId,
				timestamp: latestUpdate._creationTime,
				fileId,
			});
		} catch (e) {
			await ctx.storage.delete(fileId);
			throw e;
		}
		return null;
	},
});

export const _createSnapshot = internalMutation({
	args: {
		docId: v.string(),
		timestamp: v.number(),
		fileId: v.id("_storage"),
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const [updatesToDelete, existingSnapshots] = await Promise.all([
			ctx.db
				.query("yjsUpdates")
				.withIndex("by_doc_id", (q) =>
					q.eq("docId", args.docId).lte("_creationTime", args.timestamp),
				)
				.collect(),
			ctx.db
				.query("yjsSnapshots")
				.withIndex("by_doc_id", (q) => q.eq("docId", args.docId))
				.collect(),
		]);
		const primarySnapshot = existingSnapshots[0] ?? null;
		if (primarySnapshot) {
			await ctx.db.patch(primarySnapshot._id, {
				fileId: args.fileId,
			});
		} else {
			await ctx.db.insert("yjsSnapshots", {
				docId: args.docId,
				fileId: args.fileId,
			});
		}

		await Promise.all(
			updatesToDelete.map((u) => ctx.db.delete(u._id)),
		);
		if (primarySnapshot) {
			await ctx.storage.delete(primarySnapshot.fileId);
		}
		for (const duplicate of existingSnapshots.slice(1)) {
			await ctx.db.delete(duplicate._id);
			await ctx.storage.delete(duplicate.fileId);
		}
		return null;
	},
});

export const _listDocIdsWithPendingUpdates = internalQuery({
	args: {},
	returns: v.array(v.string()),
	handler: async (ctx) => {
		const updates = await ctx.db.query("yjsUpdates").collect();
		return [...new Set(updates.map((row) => row.docId))];
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
			await ctx.storage.delete(snapshot.fileId);
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
				await ctx.storage.delete(snapshot.fileId);
			}
		}
		return null;
	},
});

export const _getData = internalQuery({
	args: { docId: v.string() },
	handler: async (ctx, args) => {
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
		return { snapshots, updates };
	},
});

type DocData = { mergedUpdate: Uint8Array; updates: Array<{ _creationTime: number; update: ArrayBuffer }> };
async function getDocData(
	ctx: { runQuery: (...args: any[]) => Promise<{ snapshots: Array<{ fileId: any }>; updates: Array<{ _creationTime: number; update: ArrayBuffer }> }>; storage: { get: (fileId: any) => Promise<Blob | null> } },
	docId: string,
): Promise<DocData> {
	const { snapshots, updates } = await ctx.runQuery(internal.yjs._getData, {
		docId,
	});
	const snapshotBuffers = await Promise.all(
		snapshots.map(async (s) => {
			const file = await ctx.storage.get(s.fileId);
			if (!file) return new Uint8Array();
			return new Uint8Array(await file.arrayBuffer());
		}),
	);
	const logicalUpdates = reconstructLogicalUpdates(updates);
	const mergedUpdate = Y.mergeUpdates([
		...snapshotBuffers,
		...logicalUpdates.map((update) => new Uint8Array(update)),
	]);
	return { mergedUpdate, updates };
}

type StoredYjsUpdate = {
	_creationTime: number;
	update: ArrayBuffer;
	chunkGroupId?: string;
	chunkIndex?: number;
	chunkCount?: number;
};

function reconstructLogicalUpdates(updates: StoredYjsUpdate[]): ArrayBuffer[] {
	const logicalUpdates: ArrayBuffer[] = [];
	const grouped = new Map<string, Map<number, ArrayBuffer>>();
	const expectedChunkCounts = new Map<string, number>();

	for (const update of updates) {
		const { chunkGroupId, chunkIndex, chunkCount } = update;
		if (
			chunkGroupId === undefined ||
			chunkIndex === undefined ||
			chunkCount === undefined
		) {
			logicalUpdates.push(update.update);
			continue;
		}
		let group = grouped.get(chunkGroupId);
		if (!group) {
			group = new Map<number, ArrayBuffer>();
			grouped.set(chunkGroupId, group);
		}
		group.set(chunkIndex, update.update);
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
	const bytes = new Uint8Array(update);
	if (bytes.byteLength <= MAX_UPDATE_CHUNK_BYTES) {
		return [update];
	}
	const chunks: ArrayBuffer[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += MAX_UPDATE_CHUNK_BYTES) {
		const end = Math.min(offset + MAX_UPDATE_CHUNK_BYTES, bytes.byteLength);
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
