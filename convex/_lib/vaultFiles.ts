import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";

export function normalizeVaultPath(input: string): string {
	const normalized = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (normalized.includes("..")) {
		throw new ConvexError("Path traversal is not allowed.");
	}
	return normalized;
}

type TextVaultFileWrite = {
	path: string;
	contentHash: string;
	sizeBytes: number;
	updatedAtMs: number;
	clientId: string;
};

export async function upsertTextVaultFile(
	ctx: MutationCtx,
	args: TextVaultFileWrite,
): Promise<void> {
	const path = normalizeVaultPath(args.path);
	const existing = await ctx.db
		.query("vaultFiles")
		.withIndex("by_path", (q) => q.eq("path", path))
		.unique();
	if (existing) {
		if (existing.storageId) {
			await ctx.storage.delete(existing.storageId);
		}
		await ctx.db.patch(existing._id, {
			contentHash: args.contentHash,
			sizeBytes: args.sizeBytes,
			updatedAtMs: args.updatedAtMs,
			updatedByClientId: args.clientId,
			isText: true,
			storageId: undefined,
		});
		return;
	}
	await ctx.db.insert("vaultFiles", {
		path,
		contentHash: args.contentHash,
		sizeBytes: args.sizeBytes,
		updatedAtMs: args.updatedAtMs,
		updatedByClientId: args.clientId,
		isText: true,
	});
}
