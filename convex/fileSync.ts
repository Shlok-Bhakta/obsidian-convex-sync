import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requirePluginSecret } from "./security";

function normalizePath(input: string): string {
	const normalized = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (normalized.includes("..")) {
		throw new ConvexError("Path traversal is not allowed.");
	}
	return normalized;
}

export const issueUploadUrl = mutation({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		contentHash: v.string(),
		updatedAtMs: v.number(),
		sizeBytes: v.number(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizePath(args.path);
		const existing = await ctx.db
			.query("vaultFiles")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		const uploadUrl = await ctx.storage.generateUploadUrl();
		return {
			uploadUrl,
			existing:
				existing === null
					? null
					: {
							path: existing.path,
							contentHash: existing.contentHash,
							updatedAtMs: existing.updatedAtMs,
							sizeBytes: existing.sizeBytes,
							updatedByClientId: existing.updatedByClientId,
						},
		};
	},
});

export const finalizeUpload = mutation({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		updatedAtMs: v.number(),
		sizeBytes: v.number(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizePath(args.path);
		const existing = await ctx.db
			.query("vaultFiles")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (existing && existing.updatedAtMs > args.updatedAtMs) {
			await ctx.storage.delete(args.storageId);
			return {
				ok: false as const,
				reason: "stale_write" as const,
				remoteUpdatedAtMs: existing.updatedAtMs,
			};
		}

		let previousStorageId: typeof args.storageId | null = null;
		if (existing) {
			previousStorageId = existing.storageId;
			await ctx.db.patch(existing._id, {
				storageId: args.storageId,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				updatedAtMs: args.updatedAtMs,
				updatedByClientId: args.clientId,
			});
		} else {
			await ctx.db.insert("vaultFiles", {
				path,
				storageId: args.storageId,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				updatedAtMs: args.updatedAtMs,
				updatedByClientId: args.clientId,
			});
		}

		if (previousStorageId !== null && previousStorageId !== args.storageId) {
			await ctx.storage.delete(previousStorageId);
		}

		return { ok: true as const };
	},
});

export const listSnapshot = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const files = await ctx.db.query("vaultFiles").collect();
		const folders = await ctx.db.query("vaultFolders").collect();
		return {
			files: files.map((file) => ({
				path: file.path,
				contentHash: file.contentHash,
				sizeBytes: file.sizeBytes,
				updatedAtMs: file.updatedAtMs,
				updatedByClientId: file.updatedByClientId,
			})),
			folders: folders.map((folder) => ({
				path: folder.path,
				updatedAtMs: folder.updatedAtMs,
				isExplicitlyEmpty: folder.isExplicitlyEmpty,
				updatedByClientId: folder.updatedByClientId ?? "",
			})),
		};
	},
});

export const getDownloadUrl = query({
	args: { convexSecret: v.string(), path: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizePath(args.path);
		const row = await ctx.db
			.query("vaultFiles")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (!row) {
			return null;
		}
		const url = await ctx.storage.getUrl(row.storageId);
		if (!url) {
			return null;
		}
		return {
			url,
			contentHash: row.contentHash,
			sizeBytes: row.sizeBytes,
			updatedAtMs: row.updatedAtMs,
		};
	},
});

export const syncFolderState = mutation({
	args: {
		convexSecret: v.string(),
		scannedAtMs: v.number(),
		clientId: v.string(),
		emptyFolderPaths: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const normalizedEmpty = new Set(
			args.emptyFolderPaths.map((path) => normalizePath(path)),
		);
		const existing = await ctx.db.query("vaultFolders").collect();
		for (const folder of existing) {
			const shouldBeEmpty = normalizedEmpty.has(folder.path);
			await ctx.db.patch(folder._id, {
				updatedAtMs: args.scannedAtMs,
				isExplicitlyEmpty: shouldBeEmpty,
				updatedByClientId: args.clientId,
			});
			normalizedEmpty.delete(folder.path);
		}
		for (const path of normalizedEmpty) {
			await ctx.db.insert("vaultFolders", {
				path,
				updatedAtMs: args.scannedAtMs,
				isExplicitlyEmpty: true,
				updatedByClientId: args.clientId,
			});
		}
	},
});

export const removeFilesByPath = mutation({
	args: {
		convexSecret: v.string(),
		removedPaths: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const normalizedPaths = new Set(
			args.removedPaths.map((path) => normalizePath(path)),
		);
		for (const path of normalizedPaths) {
			const row = await ctx.db
				.query("vaultFiles")
				.withIndex("by_path", (q) => q.eq("path", path))
				.unique();
			if (!row) {
				continue;
			}
			await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
	},
});
