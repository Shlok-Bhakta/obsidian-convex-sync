import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

export async function finalizeStorageUpload<TExisting extends { _id: Id<any>; storageId: Id<"_storage">; updatedAtMs: number }>(options: {
	ctx: MutationCtx;
	existing: TExisting | null;
	storageId: Id<"_storage">;
	updatedAtMs: number;
	updateExisting: (id: TExisting["_id"]) => Promise<void>;
	insertNew: () => Promise<void>;
}) {
	const { ctx, existing, storageId, updatedAtMs } = options;
	if (existing && existing.updatedAtMs > updatedAtMs) {
		await ctx.storage.delete(storageId);
		return {
			ok: false as const,
			reason: "stale_write" as const,
			remoteUpdatedAtMs: existing.updatedAtMs,
		};
	}

	let previousStorageId: Id<"_storage"> | null = null;
	if (existing) {
		previousStorageId = existing.storageId;
		await options.updateExisting(existing._id);
	} else {
		await options.insertNew();
	}

	if (previousStorageId !== null && previousStorageId !== storageId) {
		await ctx.storage.delete(previousStorageId);
	}
	return { ok: true as const };
}
