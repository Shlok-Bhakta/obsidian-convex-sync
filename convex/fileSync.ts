import { v } from "convex/values";
import {
	action,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { normalizeOptionalVaultPath, normalizeVaultPath } from "./_lib/path";
import { requirePluginSecret } from "./security";

type StorageDescriptor = {
	storageId: string;
	contentHash: string;
	sizeBytes: number;
	updatedAtMs: number;
};

type FileBytesResult = {
	bytes: ArrayBuffer;
	contentHash: string;
	sizeBytes: number;
	updatedAtMs: number;
} | null;

type UploadBytesResult =
	| { ok: true }
	| { ok: false; reason: "stale_write"; remoteUpdatedAtMs: number };

export const issueUploadUrl = mutation({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		contentHash: v.string(),
		updatedAtMs: v.number(),
		sizeBytes: v.number(),
		clientId: v.string(),
		fileId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		void args.fileId;
		const path = normalizeVaultPath(args.path);
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
		fileId: v.optional(v.string()),
		force: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		void args.fileId;
		const path = normalizeVaultPath(args.path);
		const existing = await ctx.db
			.query("vaultFiles")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (existing && !args.force && existing.updatedAtMs > args.updatedAtMs) {
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

export const finalizeActionUpload = internalMutation({
	args: {
		path: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		updatedAtMs: v.number(),
		sizeBytes: v.number(),
		clientId: v.string(),
		force: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const path = normalizeVaultPath(args.path);
		const existing = await ctx.db
			.query("vaultFiles")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (existing && !args.force && existing.updatedAtMs > args.updatedAtMs) {
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

export const listFolderSnapshot = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const folders = await ctx.db.query("vaultFolders").collect();
		return folders.map((folder) => ({
			path: folder.path,
			updatedAtMs: folder.updatedAtMs,
			isExplicitlyEmpty: folder.isExplicitlyEmpty,
			updatedByClientId: folder.updatedByClientId ?? "",
		}));
	},
});

export const getDownloadUrl = query({
	args: { convexSecret: v.string(), path: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizeVaultPath(args.path);
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

export const getStorageDescriptorByPath = internalQuery({
	args: { path: v.string() },
	handler: async (ctx, args) => {
		const path = normalizeVaultPath(args.path);
		const row = await ctx.db
			.query("vaultFiles")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (!row) {
			return null;
		}
		return {
			storageId: row.storageId,
			contentHash: row.contentHash,
			sizeBytes: row.sizeBytes,
			updatedAtMs: row.updatedAtMs,
		};
	},
});

export const getFileBytes = action({
	args: { convexSecret: v.string(), path: v.string() },
	returns: v.union(
		v.null(),
		v.object({
			bytes: v.bytes(),
			contentHash: v.string(),
			sizeBytes: v.number(),
			updatedAtMs: v.number(),
		}),
	),
	handler: async (ctx, args): Promise<FileBytesResult> => {
		const auth = await ctx.runQuery(internal.security.validatePluginSecret, {
			secret: args.convexSecret,
		});
		if (!auth.ok) {
			throw new Error("The vault API key is invalid for this Convex deployment.");
		}
		const descriptor = (await ctx.runQuery(
			(internal as any).fileSync.getStorageDescriptorByPath,
			{ path: args.path },
		)) as StorageDescriptor | null;
		if (!descriptor) {
			return null;
		}
		const blob = await ctx.storage.get(descriptor.storageId as never);
		if (!blob) {
			return null;
		}
		return {
			bytes: await blob.arrayBuffer(),
			contentHash: descriptor.contentHash,
			sizeBytes: descriptor.sizeBytes,
			updatedAtMs: descriptor.updatedAtMs,
		};
	},
});

export const uploadFileBytes = action({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		bytes: v.bytes(),
		contentHash: v.string(),
		updatedAtMs: v.number(),
		sizeBytes: v.number(),
		clientId: v.string(),
		force: v.optional(v.boolean()),
	},
	handler: async (ctx, args): Promise<UploadBytesResult> => {
		const auth = await ctx.runQuery(internal.security.validatePluginSecret, {
			secret: args.convexSecret,
		});
		if (!auth.ok) {
			throw new Error("The vault API key is invalid for this Convex deployment.");
		}
		const storageId = await ctx.storage.store(
			new Blob([args.bytes], { type: "application/octet-stream" }),
		);
		return (await ctx.runMutation((internal as any).fileSync.finalizeActionUpload, {
			path: args.path,
			storageId,
			contentHash: args.contentHash,
			updatedAtMs: args.updatedAtMs,
			sizeBytes: args.sizeBytes,
			clientId: args.clientId,
			force: args.force,
		})) as UploadBytesResult;
	},
});

export const syncFolderState = mutation({
	args: {
		convexSecret: v.string(),
		scannedAtMs: v.number(),
		clientId: v.string(),
		folderPaths: v.optional(v.array(v.string())),
		emptyFolderPaths: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const normalizedEmpty = new Set(
			args.emptyFolderPaths
				.map((path) => normalizeOptionalVaultPath(path))
				.filter((path): path is string => path !== null),
		);
		const existing = await ctx.db.query("vaultFolders").collect();
		if (!args.folderPaths) {
			for (const folder of existing) {
				const shouldBeEmpty = normalizedEmpty.has(folder.path);
				if (folder.isExplicitlyEmpty !== shouldBeEmpty) {
					await ctx.db.patch(folder._id, {
						updatedAtMs: args.scannedAtMs,
						isExplicitlyEmpty: shouldBeEmpty,
						updatedByClientId: args.clientId,
					});
				}
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
			return;
		}
		const normalizedFolders = new Set(
			args.folderPaths
				.map((path) => normalizeOptionalVaultPath(path))
				.filter((path): path is string => path !== null),
		);
		for (const path of normalizedEmpty) {
			normalizedFolders.add(path);
		}
		for (const folder of existing) {
			const stillExists = normalizedFolders.has(folder.path);
			if (!stillExists) {
				await ctx.db.delete(folder._id);
				continue;
			}
			const shouldBeEmpty = normalizedEmpty.has(folder.path);
			if (folder.isExplicitlyEmpty !== shouldBeEmpty) {
				await ctx.db.patch(folder._id, {
					updatedAtMs: args.scannedAtMs,
					isExplicitlyEmpty: shouldBeEmpty,
					updatedByClientId: args.clientId,
				});
			}
			normalizedFolders.delete(folder.path);
			normalizedEmpty.delete(folder.path);
		}
		for (const path of normalizedFolders) {
			await ctx.db.insert("vaultFolders", {
				path,
				updatedAtMs: args.scannedAtMs,
				isExplicitlyEmpty: normalizedEmpty.has(path),
				updatedByClientId: args.clientId,
			});
		}
	},
});

export const syncFolderStateForRoot = mutation({
	args: {
		convexSecret: v.string(),
		scannedAtMs: v.number(),
		clientId: v.string(),
		rootPath: v.string(),
		folderPaths: v.array(v.string()),
		emptyFolderPaths: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const rootPath = normalizeVaultPath(args.rootPath);
		const isWithinRoot = (path: string) =>
			path === rootPath || path.startsWith(`${rootPath}/`);
		const normalizedEmpty = new Set(
			args.emptyFolderPaths
				.map((path) => normalizeOptionalVaultPath(path))
				.filter((path): path is string => path !== null && isWithinRoot(path)),
		);
		const normalizedFolders = new Set(
			args.folderPaths
				.map((path) => normalizeOptionalVaultPath(path))
				.filter((path): path is string => path !== null && isWithinRoot(path)),
		);
		for (const path of normalizedEmpty) {
			normalizedFolders.add(path);
		}

		const existing = await ctx.db.query("vaultFolders").collect();
		for (const folder of existing) {
			if (!isWithinRoot(folder.path)) {
				continue;
			}
			const stillExists = normalizedFolders.has(folder.path);
			if (!stillExists) {
				await ctx.db.delete(folder._id);
				continue;
			}
			const shouldBeEmpty = normalizedEmpty.has(folder.path);
			if (folder.isExplicitlyEmpty !== shouldBeEmpty) {
				await ctx.db.patch(folder._id, {
					updatedAtMs: args.scannedAtMs,
					isExplicitlyEmpty: shouldBeEmpty,
					updatedByClientId: args.clientId,
				});
			}
			normalizedFolders.delete(folder.path);
			normalizedEmpty.delete(folder.path);
		}
		for (const path of normalizedFolders) {
			await ctx.db.insert("vaultFolders", {
				path,
				updatedAtMs: args.scannedAtMs,
				isExplicitlyEmpty: normalizedEmpty.has(path),
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
			args.removedPaths.map((path) => normalizeVaultPath(path)),
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

export const issueBundleUploadUrl = mutation({
	args: {
		convexSecret: v.string(),
		contentHash: v.string(),
		updatedAtMs: v.number(),
		sizeBytes: v.number(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		void args;
		return { uploadUrl: await ctx.storage.generateUploadUrl() };
	},
});

export const finalizeBundleUpload = mutation({
	args: {
		convexSecret: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		updatedAtMs: v.number(),
		sizeBytes: v.number(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		await ctx.storage.delete(args.storageId);
		return { ok: true as const };
	},
});

export const getBundleDownloadUrl = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		return null;
	},
});
