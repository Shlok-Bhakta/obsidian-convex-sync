import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
	action,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { paginationOptsValidator } from "convex/server";
import { requirePluginSecret } from "./security";

/** Convex action return payload must stay under ~16 MiB; keep chunks below that. */
const DEFAULT_FILE_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_FILE_CHUNK_BYTES = 12 * 1024 * 1024;

type GetFileBytesChunkResult =
	| null
	| {
			bytes: ArrayBuffer;
			contentHash: string;
			sizeBytes: number;
			updatedAtMs: number;
			byteOffset: number;
			isLast: boolean;
	  };

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
		/** Newer clients send these; ignored until versioning / kind routing is unified server-side. */
		contentKind: v.optional(v.union(v.literal("text"), v.literal("binary"))),
		retainBinaryVersions: v.optional(v.number()),
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
		/** When set, row is indexed as text vs binary (`isText`). Defaults to binary for older clients. */
		contentKind: v.optional(v.union(v.literal("text"), v.literal("binary"))),
		/** Reserved for future per-path binary version retention; accepted so clients do not fail validation. */
		retainBinaryVersions: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizePath(args.path);
		const isText = args.contentKind === "text";
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
			previousStorageId = existing.storageId ?? null;
			await ctx.db.patch(existing._id, {
				storageId: args.storageId,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				updatedAtMs: args.updatedAtMs,
				updatedByClientId: args.clientId,
				isText,
			});
		} else {
			await ctx.db.insert("vaultFiles", {
				path,
				storageId: args.storageId,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				updatedAtMs: args.updatedAtMs,
				updatedByClientId: args.clientId,
				isText,
			});
		}

		if (previousStorageId !== null && previousStorageId !== args.storageId) {
			await ctx.storage.delete(previousStorageId);
		}

		return { ok: true as const };
	},
});

export const registerTextFile = mutation({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		contentHash: v.string(),
		sizeBytes: v.number(),
		updatedAtMs: v.number(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizePath(args.path);
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
		} else {
			await ctx.db.insert("vaultFiles", {
				path,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				updatedAtMs: args.updatedAtMs,
				updatedByClientId: args.clientId,
				isText: true,
			});
		}
	},
});

function mapBinaryVaultFileRow(f: {
	path: string;
	contentHash: string;
	updatedAtMs: number;
}) {
	return {
		path: f.path,
		contentHash: f.contentHash,
		updatedAtMs: f.updatedAtMs,
	};
}

export const listFilesChangedSince = query({
	args: {
		convexSecret: v.string(),
		sinceMs: v.number(),
		sincePath: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const sincePath = args.sincePath ?? "";

		let files: Array<{
			path: string;
			contentHash: string;
			updatedAtMs: number;
		}>;

		if (args.sinceMs === 0 && sincePath === "") {
			files = await ctx.db
				.query("vaultFiles")
				.withIndex("by_isText_updatedAtMs", (q) => q.eq("isText", false))
				.collect();
		} else {
			const strictAfter = await ctx.db
				.query("vaultFiles")
				.withIndex("by_isText_updatedAtMs", (q) =>
					q.eq("isText", false).gt("updatedAtMs", args.sinceMs),
				)
				.collect();
			const sameMsAfterPath = await ctx.db
				.query("vaultFiles")
				.withIndex("by_isText_updatedAtMs", (q) =>
					q.eq("isText", false).eq("updatedAtMs", args.sinceMs),
				)
				.filter((q) => q.gt(q.field("path"), sincePath))
				.collect();
			const byId = new Map<
				string,
				{ path: string; contentHash: string; updatedAtMs: number }
			>();
			for (const f of strictAfter) {
				byId.set(f._id, f);
			}
			for (const f of sameMsAfterPath) {
				byId.set(f._id, f);
			}
			files = [...byId.values()];
		}

		return files.map(mapBinaryVaultFileRow);
	},
});

export const listFileHashes = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const files = await ctx.db
			.query("vaultFiles")
			.withIndex("by_isText_updatedAtMs", (q) => q.eq("isText", false))
			.collect();
		return files.map((f) => ({
			path: f.path,
			contentHash: f.contentHash,
			updatedAtMs: f.updatedAtMs,
		}));
	},
});

export const listBinarySnapshotPage = query({
	args: {
		convexSecret: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const page = await ctx.db
			.query("vaultFiles")
			.withIndex("by_isText_updatedAtMs", (q) => q.eq("isText", false))
			.paginate(args.paginationOpts);
		return {
			page: page.page.map((file) => ({
				path: file.path,
				contentHash: file.contentHash,
				sizeBytes: file.sizeBytes,
				updatedAtMs: file.updatedAtMs,
				updatedByClientId: file.updatedByClientId,
				isText: file.isText,
				storageId: file.storageId,
			})),
			isDone: page.isDone,
			continueCursor: page.continueCursor,
		};
	},
});

export const listFolderSnapshotPage = query({
	args: {
		convexSecret: v.string(),
		paginationOpts: paginationOptsValidator,
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const page = await ctx.db
			.query("vaultFolders")
			.withIndex("by_updatedAtMs")
			.paginate(args.paginationOpts);
		return {
			page: page.page.map((folder) => ({
				path: folder.path,
				updatedAtMs: folder.updatedAtMs,
				isExplicitlyEmpty: folder.isExplicitlyEmpty,
				updatedByClientId: folder.updatedByClientId ?? "",
			})),
			isDone: page.isDone,
			continueCursor: page.continueCursor,
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
		if (!row || !row.storageId) {
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

export const getRowByPath = internalQuery({
	args: { path: v.string() },
	handler: async (ctx, args) => {
		const path = normalizePath(args.path);
		return await ctx.db
			.query("vaultFiles")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
	},
});

/**
 * Reads a byte range from file storage (fallback when signed URL download fails).
 * Use sequential chunks; each response stays under the Convex action size limit.
 */
export const getFileBytesChunk = action({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		byteOffset: v.number(),
		maxBytes: v.optional(v.number()),
	},
	returns: v.union(
		v.null(),
		v.object({
			bytes: v.bytes(),
			contentHash: v.string(),
			sizeBytes: v.number(),
			updatedAtMs: v.number(),
			byteOffset: v.number(),
			isLast: v.boolean(),
		}),
	),
	handler: async (ctx, args): Promise<GetFileBytesChunkResult> => {
		const auth = await ctx.runQuery(internal.security.validatePluginSecret, {
			secret: args.convexSecret,
		});
		if (!auth.ok) {
			throw new Error("The vault API key is invalid for this Convex deployment.");
		}
		if (args.byteOffset < 0 || !Number.isFinite(args.byteOffset)) {
			throw new ConvexError("byteOffset must be a non-negative finite number.");
		}
		const requested =
			args.maxBytes === undefined
				? DEFAULT_FILE_CHUNK_BYTES
				: Math.min(MAX_FILE_CHUNK_BYTES, Math.max(1, args.maxBytes));
		const path = normalizePath(args.path);
		const row = await ctx.runQuery(internal.fileSync.getRowByPath, {
			path,
		});
		if (!row || !row.storageId) {
			return null;
		}
		const blob = await ctx.storage.get(row.storageId);
		if (!blob) {
			return null;
		}
		const totalSize =
			typeof blob.size === "number" && blob.size > 0 ? blob.size : row.sizeBytes;
		if (totalSize === 0 && args.byteOffset === 0) {
			return {
				bytes: new ArrayBuffer(0),
				contentHash: row.contentHash,
				sizeBytes: 0,
				updatedAtMs: row.updatedAtMs,
				byteOffset: 0,
				isLast: true,
			};
		}
		if (args.byteOffset >= totalSize) {
			return null;
		}
		const end = Math.min(args.byteOffset + requested, totalSize);
		const slice = blob.slice(args.byteOffset, end);
		const bytes = await slice.arrayBuffer();
		return {
			bytes,
			contentHash: row.contentHash,
			sizeBytes: totalSize,
			updatedAtMs: row.updatedAtMs,
			byteOffset: args.byteOffset,
			isLast: end >= totalSize,
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
			// Keep "explicitly empty" monotonic for existing rows during full scans.
			// This avoids re-marking a folder as empty if events changed it mid-scan.
			if (shouldBeEmpty) {
				if (folder.isExplicitlyEmpty) {
					await ctx.db.patch(folder._id, {
						updatedAtMs: args.scannedAtMs,
						updatedByClientId: args.clientId,
					});
				}
			} else if (folder.isExplicitlyEmpty) {
				await ctx.db.patch(folder._id, {
					updatedAtMs: args.scannedAtMs,
					isExplicitlyEmpty: false,
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
			if (row.storageId) {
				await ctx.storage.delete(row.storageId);
			}
			await ctx.db.delete(row._id);
			if (row.isText) {
				await ctx.scheduler.runAfter(0, internal.yjsSync._removeDocsByPathSuffix, {
					path,
				});
			}
		}
	},
});

export const removeFoldersByPath = mutation({
	args: {
		convexSecret: v.string(),
		removedPaths: v.array(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		for (const raw of args.removedPaths) {
			const path = normalizePath(raw);
			const existing = await ctx.db
				.query("vaultFolders")
				.withIndex("by_path", (q) => q.eq("path", path))
				.unique();
			if (existing) {
				await ctx.db.delete(existing._id);
			}
		}
	},
});

/** Reactive subscription: all vaultFiles (text+binary) + vaultFolders metadata. */
export const listAllMetadata = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const [files, folders] = await Promise.all([
			ctx.db.query("vaultFiles").collect(),
			ctx.db.query("vaultFolders").collect(),
		]);
		return {
			files: files.map((f) => ({
				path: f.path,
				contentHash: f.contentHash,
				updatedAtMs: f.updatedAtMs,
				isText: f.isText,
			})),
			folders: folders.map((f) => ({
				path: f.path,
				updatedAtMs: f.updatedAtMs,
				isExplicitlyEmpty: f.isExplicitlyEmpty,
			})),
		};
	},
});

/** Catch-up: all vaultFiles + vaultFolders changed since a server-anchored timestamp. */
export const listAllChangesSince = query({
	args: { convexSecret: v.string(), sinceMs: v.number() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const [files, folders] = await Promise.all([
			ctx.db
				.query("vaultFiles")
				.withIndex("by_updatedAtMs", (q) => q.gt("updatedAtMs", args.sinceMs))
				.collect(),
			ctx.db
				.query("vaultFolders")
				.withIndex("by_updatedAtMs", (q) => q.gt("updatedAtMs", args.sinceMs))
				.collect(),
		]);
		return {
			files: files.map((f) => ({
				path: f.path,
				contentHash: f.contentHash,
				updatedAtMs: f.updatedAtMs,
				isText: f.isText,
				sizeBytes: f.sizeBytes,
			})),
			folders: folders.map((f) => ({
				path: f.path,
				updatedAtMs: f.updatedAtMs,
				isExplicitlyEmpty: f.isExplicitlyEmpty,
			})),
		};
	},
});

/** Server-anchored timestamp so the client can store a sync watermark from Convex (not device clock). */
export const getServerTimestamp = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		return { serverNowMs: Date.now() };
	},
});

/** Realtime-safe: upsert one explicitly-empty folder without rewriting all folder rows. */
export const registerExplicitEmptyFolder = mutation({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		scannedAtMs: v.number(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizePath(args.path);
		const existing = await ctx.db
			.query("vaultFolders")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, {
				updatedAtMs: args.scannedAtMs,
				isExplicitlyEmpty: true,
				updatedByClientId: args.clientId,
			});
		} else {
			await ctx.db.insert("vaultFolders", {
				path,
				updatedAtMs: args.scannedAtMs,
				isExplicitlyEmpty: true,
				updatedByClientId: args.clientId,
			});
		}
	},
});

