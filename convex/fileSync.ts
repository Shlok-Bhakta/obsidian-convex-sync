import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requirePluginSecret } from "./security";

const contentKindValidator = v.union(v.literal("text"), v.literal("binary"));
const operationKindValidator = v.union(
	v.literal("file_upsert"),
	v.literal("file_delete"),
	v.literal("path_rename"),
);
const entryTypeValidator = v.union(
	v.literal("file"),
	v.literal("folder"),
);

function normalizeCommittedUpdatedAtMs(input: number, serverNow = Date.now()): number {
	return Math.min(input, serverNow);
}

function comparableStoredUpdatedAtMs(input: number, serverNow = Date.now()): number {
	return Math.min(input, serverNow);
}

function normalizePath(input: string): string {
	const normalized = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (normalized.includes("..")) {
		throw new ConvexError("Path traversal is not allowed.");
	}
	return normalized;
}

async function recordOperation(
	ctx: any,
	args: {
		clientId: string;
		kind: "file_upsert" | "file_delete" | "path_rename";
		entryType: "file" | "folder";
		path: string;
		oldPath?: string;
		contentHash?: string;
		contentKind?: "text" | "binary";
		sizeBytes?: number;
		updatedAtMs: number;
	},
): Promise<void> {
	await ctx.db.insert("vaultOperations", args);
}

async function pruneBinaryVersions(
	ctx: any,
	path: string,
	retainBinaryVersions: number,
): Promise<void> {
	const versions = await ctx.db
		.query("vaultBinaryVersions")
		.withIndex("by_path", (q: any) => q.eq("path", path))
		.collect();
	const overflow = versions
		.sort((a: any, b: any) => b.createdAtMs - a.createdAtMs)
		.slice(Math.max(retainBinaryVersions, 0));
	for (const row of overflow) {
		await ctx.storage.delete(row.storageId);
		await ctx.db.delete(row._id);
	}
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

export const repairFutureTimestamps = mutation({
	args: {
		convexSecret: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const now = Date.now();
		let repairedFiles = 0;
		let repairedFolders = 0;
		let repairedOperations = 0;
		let repairedTrash = 0;
		let repairedBinaryVersions = 0;

		for (const row of await ctx.db.query("vaultFiles").collect()) {
			const updatedAtMs = comparableStoredUpdatedAtMs(row.updatedAtMs, now);
			if (updatedAtMs !== row.updatedAtMs) {
				await ctx.db.patch(row._id, { updatedAtMs });
				repairedFiles += 1;
			}
		}

		for (const row of await ctx.db.query("vaultFolders").collect()) {
			const updatedAtMs = comparableStoredUpdatedAtMs(row.updatedAtMs, now);
			if (updatedAtMs !== row.updatedAtMs) {
				await ctx.db.patch(row._id, { updatedAtMs });
				repairedFolders += 1;
			}
		}

		for (const row of await ctx.db.query("vaultOperations").collect()) {
			const updatedAtMs = comparableStoredUpdatedAtMs(row.updatedAtMs, now);
			if (updatedAtMs !== row.updatedAtMs) {
				await ctx.db.patch(row._id, { updatedAtMs });
				repairedOperations += 1;
			}
		}

		for (const row of await ctx.db.query("vaultFileTrash").collect()) {
			const deletedAtMs = comparableStoredUpdatedAtMs(row.deletedAtMs, now);
			const delta = Math.max(0, row.expiresAtMs - row.deletedAtMs);
			const expiresAtMs = deletedAtMs + delta;
			const lastKnownUpdatedAtMs = comparableStoredUpdatedAtMs(
				row.lastKnownUpdatedAtMs,
				now,
			);
			if (
				deletedAtMs !== row.deletedAtMs ||
				expiresAtMs !== row.expiresAtMs ||
				lastKnownUpdatedAtMs !== row.lastKnownUpdatedAtMs
			) {
				await ctx.db.patch(row._id, {
					deletedAtMs,
					expiresAtMs,
					lastKnownUpdatedAtMs,
				});
				repairedTrash += 1;
			}
		}

		for (const row of await ctx.db.query("vaultBinaryVersions").collect()) {
			const createdAtMs = comparableStoredUpdatedAtMs(row.createdAtMs, now);
			if (createdAtMs !== row.createdAtMs) {
				await ctx.db.patch(row._id, { createdAtMs });
				repairedBinaryVersions += 1;
			}
		}

		return {
			repairedFiles,
			repairedFolders,
			repairedOperations,
			repairedTrash,
			repairedBinaryVersions,
		};
	},
});

export const finalizeUpload = mutation({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		contentKind: contentKindValidator,
		updatedAtMs: v.number(),
		sizeBytes: v.number(),
		clientId: v.string(),
		retainBinaryVersions: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizePath(args.path);
		const serverNow = Date.now();
		const incomingUpdatedAtMs = normalizeCommittedUpdatedAtMs(
			args.updatedAtMs,
			serverNow,
		);
		const existing = await ctx.db
			.query("vaultFiles")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		const existingComparableUpdatedAtMs =
			existing === null
				? null
				: comparableStoredUpdatedAtMs(existing.updatedAtMs, serverNow);
		if (
			existing &&
			existingComparableUpdatedAtMs !== null &&
			existingComparableUpdatedAtMs > incomingUpdatedAtMs &&
			existing.contentHash !== args.contentHash
		) {
			await ctx.storage.delete(args.storageId);
			return {
				ok: false as const,
				reason: "stale_write" as const,
				remoteUpdatedAtMs: existingComparableUpdatedAtMs,
			};
		}

		let previousStorageId: typeof args.storageId | null = null;
		if (existing) {
			previousStorageId = existing.storageId;
			if (
				existing.storageId !== args.storageId &&
				existing.contentKind === "binary" &&
				args.retainBinaryVersions > 0
			) {
				await ctx.db.insert("vaultBinaryVersions", {
					path,
					storageId: existing.storageId,
					contentHash: existing.contentHash,
					sizeBytes: existing.sizeBytes,
					createdAtMs: existing.updatedAtMs,
				});
				previousStorageId = null;
			}
			await ctx.db.patch(existing._id, {
				storageId: args.storageId,
				contentHash: args.contentHash,
				contentKind: args.contentKind,
				sizeBytes: args.sizeBytes,
				updatedAtMs: incomingUpdatedAtMs,
				updatedByClientId: args.clientId,
			});
		} else {
			await ctx.db.insert("vaultFiles", {
				path,
				storageId: args.storageId,
				contentHash: args.contentHash,
				contentKind: args.contentKind,
				sizeBytes: args.sizeBytes,
				updatedAtMs: incomingUpdatedAtMs,
				updatedByClientId: args.clientId,
			});
		}

		if (previousStorageId !== null && previousStorageId !== args.storageId) {
			await ctx.storage.delete(previousStorageId);
		}
		if (args.contentKind === "binary") {
			await pruneBinaryVersions(ctx, path, args.retainBinaryVersions);
		}
		await recordOperation(ctx, {
			clientId: args.clientId,
			kind: "file_upsert",
			entryType: "file",
			path,
			contentHash: args.contentHash,
			contentKind: args.contentKind,
			sizeBytes: args.sizeBytes,
			updatedAtMs: incomingUpdatedAtMs,
		});

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
				contentKind: file.contentKind,
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
			contentKind: row.contentKind,
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
		const scannedAtMs = normalizeCommittedUpdatedAtMs(args.scannedAtMs);
		const normalizedEmpty = new Set(
			args.emptyFolderPaths.map((path) => normalizePath(path)),
		);
		const existing = await ctx.db.query("vaultFolders").collect();
		for (const folder of existing) {
			const shouldBeEmpty = normalizedEmpty.has(folder.path);
			await ctx.db.patch(folder._id, {
				updatedAtMs: scannedAtMs,
				isExplicitlyEmpty: shouldBeEmpty,
				updatedByClientId: args.clientId,
			});
			normalizedEmpty.delete(folder.path);
		}
		for (const path of normalizedEmpty) {
			await ctx.db.insert("vaultFolders", {
				path,
				updatedAtMs: scannedAtMs,
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
		clientId: v.string(),
		deletedAtMs: v.number(),
		trashRetentionDays: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const deletedAtMs = normalizeCommittedUpdatedAtMs(args.deletedAtMs);
		const normalizedPaths = new Set(
			args.removedPaths.map((path) => normalizePath(path)),
		);
		const expiresAtMs =
			deletedAtMs +
			Math.max(1, Math.round(args.trashRetentionDays)) * 24 * 60 * 60 * 1000;
		for (const path of normalizedPaths) {
			const row = await ctx.db
				.query("vaultFiles")
				.withIndex("by_path", (q) => q.eq("path", path))
				.unique();
			if (!row) {
				continue;
			}
			await ctx.db.insert("vaultFileTrash", {
				path: row.path,
				storageId: row.storageId,
				contentHash: row.contentHash,
				sizeBytes: row.sizeBytes,
				contentKind: row.contentKind,
				lastKnownUpdatedAtMs: row.updatedAtMs,
				deletedAtMs,
				deletedByClientId: args.clientId,
				expiresAtMs,
			});
			await ctx.db.delete(row._id);
			await recordOperation(ctx, {
				clientId: args.clientId,
				kind: "file_delete",
				entryType: "file",
				path,
				contentHash: row.contentHash,
				contentKind: row.contentKind,
				sizeBytes: row.sizeBytes,
				updatedAtMs: deletedAtMs,
			});
		}
	},
});

export const renamePath = mutation({
	args: {
		convexSecret: v.string(),
		oldPath: v.string(),
		newPath: v.string(),
		clientId: v.string(),
		updatedAtMs: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const oldPath = normalizePath(args.oldPath);
		const newPath = normalizePath(args.newPath);
		const updatedAtMs = normalizeCommittedUpdatedAtMs(args.updatedAtMs);
		if (!oldPath || !newPath) {
			throw new ConvexError("Both oldPath and newPath are required.");
		}

		const rebasePath = (path: string): string =>
			path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`;

		const files = await ctx.db.query("vaultFiles").collect();
		for (const row of files) {
			if (row.path === oldPath || row.path.startsWith(`${oldPath}/`)) {
				await ctx.db.patch(row._id, {
					path: rebasePath(row.path),
					updatedAtMs,
					updatedByClientId: args.clientId,
				});
			}
		}

		const folders = await ctx.db.query("vaultFolders").collect();
		for (const row of folders) {
			if (row.path === oldPath || row.path.startsWith(`${oldPath}/`)) {
				await ctx.db.patch(row._id, {
					path: rebasePath(row.path),
					updatedAtMs,
					updatedByClientId: args.clientId,
				});
			}
		}

		const trashed = await ctx.db.query("vaultFileTrash").collect();
		for (const row of trashed) {
			if (row.path === oldPath || row.path.startsWith(`${oldPath}/`)) {
				await ctx.db.patch(row._id, {
					path: rebasePath(row.path),
				});
			}
		}

		const binaryVersions = await ctx.db.query("vaultBinaryVersions").collect();
		for (const row of binaryVersions) {
			if (row.path === oldPath || row.path.startsWith(`${oldPath}/`)) {
				await ctx.db.patch(row._id, {
					path: rebasePath(row.path),
				});
			}
		}

		await recordOperation(ctx, {
			clientId: args.clientId,
			kind: "path_rename",
			entryType: "folder",
			path: newPath,
			oldPath,
			updatedAtMs,
		});
		return { ok: true as const };
	},
});

export const listRecentOperations = query({
	args: {
		convexSecret: v.string(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const limit = Math.max(1, Math.min(500, args.limit ?? 200));
		const rows = await ctx.db.query("vaultOperations").collect();
		return rows
			.sort((a, b) =>
				a.updatedAtMs === b.updatedAtMs
					? a._creationTime - b._creationTime
					: a.updatedAtMs - b.updatedAtMs,
			)
			.slice(-limit)
			.map((row) => ({
				id: row._id,
				clientId: row.clientId,
				kind: row.kind,
				entryType: row.entryType,
				path: row.path,
				oldPath: row.oldPath ?? null,
				contentHash: row.contentHash ?? null,
				contentKind: row.contentKind ?? null,
				sizeBytes: row.sizeBytes ?? null,
				updatedAtMs: row.updatedAtMs,
			}));
	},
});

export const cleanupExpiredTrash = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const rows = await ctx.db.query("vaultFileTrash").collect();
		for (const row of rows) {
			if (row.expiresAtMs > now) {
				continue;
			}
			await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
	},
});
