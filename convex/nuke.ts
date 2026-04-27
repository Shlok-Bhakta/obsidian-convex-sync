import { internalAction, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const NUKABLE_TABLES = [
	"vaultFiles",
	"vaultFolders",
	"vaultBootstraps",
	"pluginAuth",
	"clientPresence",
	"yjsAwarenessUpdates",
	"yjsUpdates",
	"yjsSnapshots",
] as const;

const nukeTableName = v.union(
	v.literal("vaultFiles"),
	v.literal("vaultFolders"),
	v.literal("vaultBootstraps"),
	v.literal("pluginAuth"),
	v.literal("clientPresence"),
	v.literal("yjsAwarenessUpdates"),
	v.literal("yjsUpdates"),
	v.literal("yjsSnapshots"),
);

const DELETE_BATCH_SIZE = 256;
const MIN_DELETE_BATCH_SIZE = 1;

function isTooManyBytesReadError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	return error.message.includes("Too many bytes read");
}

/**
 * Internal kill switch for development environments.
 * Deletes all rows in every app table and removes referenced blobs from storage.
 */
export const nuke = internalAction({
	args: {},
	returns: v.object({
		deletedDocs: v.number(),
		deletedStorageBlobs: v.number(),
	}),
	handler: async (ctx) => {
		const storageIds = new Set<Id<"_storage">>();
		let deletedDocs = 0;

		for (const tableName of NUKABLE_TABLES) {
			let batchSize = DELETE_BATCH_SIZE;
			while (true) {
				let batch;
				try {
					batch = await ctx.runMutation(internal.nuke._deleteTableBatch, {
						tableName,
						batchSize,
					});
				} catch (error) {
					if (isTooManyBytesReadError(error) && batchSize > MIN_DELETE_BATCH_SIZE) {
						batchSize = Math.max(MIN_DELETE_BATCH_SIZE, Math.floor(batchSize / 2));
						continue;
					}
					throw error;
				}
				deletedDocs += batch.deletedCount;
				for (const storageId of batch.storageIds) {
					storageIds.add(storageId);
				}
				if (batch.deletedCount === 0) {
					break;
				}
			}
		}

		let deletedStorageBlobs = 0;
		for (const storageId of storageIds) {
			await ctx.storage.delete(storageId);
			deletedStorageBlobs += 1;
		}

		return { deletedDocs, deletedStorageBlobs };
	},
});

export const _deleteTableBatch = internalMutation({
	args: {
		tableName: nukeTableName,
		batchSize: v.number(),
	},
	returns: v.object({
		deletedCount: v.number(),
		storageIds: v.array(v.id("_storage")),
	}),
	handler: async (ctx, args) => {
		const docs = await ctx.db.query(args.tableName).take(args.batchSize);
		const storageIds: Id<"_storage">[] = [];
		for (const doc of docs) {
			if (args.tableName === "vaultFiles" || args.tableName === "vaultBootstraps") {
				const candidate = (doc as { storageId?: Id<"_storage"> }).storageId;
				if (candidate) {
					storageIds.push(candidate);
				}
			}
			if (args.tableName === "yjsSnapshots") {
				const candidate = (doc as { fileId: Id<"_storage"> }).fileId;
				if (candidate) {
					storageIds.push(candidate);
				}
			}
		}
		await Promise.all(docs.map((doc) => ctx.db.delete(doc._id)));
		return {
			deletedCount: docs.length,
			storageIds,
		};
	},
});
