import { v } from "convex/values";
import { mutation } from "./_generated/server";
import type { Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const WIPE_CONFIRMATION = "WIPE_LOCAL_DEV_DB";
const BATCH_SIZE = 50;

const tableNames = [
	"clientPresence",
	"conflicts",
	"fileManifests",
	"fileRevisions",
	"fileSnapshots",
	"globalChanges",
	"pluginAuth",
	"syncHead",
	"tasks",
	"vaultBinaryVersions",
	"vaultBootstraps",
	"vaultFileTrash",
	"vaultFiles",
	"vaultFolders",
	"vaultOperations",
] as const satisfies readonly TableNames[];

type MaybeStorageRefs = {
	storageId?: Id<"_storage">;
	attemptedStorageId?: Id<"_storage">;
};

async function deleteStorageIfPresent(
	ctx: MutationCtx,
	storageId: Id<"_storage"> | undefined,
): Promise<void> {
	if (storageId) {
		try {
			await ctx.storage.delete(storageId);
		} catch (_error) {
			// The local dev DB can contain stale storage ids from prior test runs.
		}
	}
}

export const wipeBatch = mutation({
	args: { confirm: v.string() },
	returns: v.object({ deleted: v.number() }),
	handler: async (ctx, args) => {
		if (args.confirm !== WIPE_CONFIRMATION) {
			throw new Error(`Refusing to wipe database without ${WIPE_CONFIRMATION}.`);
		}

		let deleted = 0;
		for (const table of tableNames) {
			const rows = await ctx.db.query(table).take(BATCH_SIZE);
			for (const row of rows) {
				const refs = row as MaybeStorageRefs;
				await deleteStorageIfPresent(ctx, refs.storageId);
				await deleteStorageIfPresent(ctx, refs.attemptedStorageId);
				await ctx.db.delete(row._id);
				deleted += 1;
			}
		}

		return { deleted };
	},
});
