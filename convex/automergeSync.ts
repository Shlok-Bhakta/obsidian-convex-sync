import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requirePluginSecret } from "./security";
import { hash as sha256 } from "fast-sha256";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

const changeType = v.union(v.literal("incremental"), v.literal("snapshot"));

export const submitChanges = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		clientId: v.string(),
		idempotencyKey: v.string(),
		changes: v.array(
			v.object({
				type: changeType,
				data: v.bytes(),
			}),
		),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);

		const existingByKey = await ctx.db
			.query("automergeChanges")
			.withIndex("by_docId_idempotencyKey", (q) =>
				q.eq("docId", args.docId).eq("idempotencyKey", args.idempotencyKey),
			)
			.collect();
		if (existingByKey.length > 0) {
			return {
				ok: true as const,
				duplicate: true as const,
				inserted: 0,
				serverCursor: maxCreationTime(existingByKey),
			};
		}

		let inserted = 0;
		let serverCursor = 0;
		for (const change of args.changes) {
			const hash = hashBytes(new Uint8Array(change.data));
			const existingByHash = await ctx.db
				.query("automergeChanges")
				.withIndex("by_docId_type_hash", (q) =>
					q
						.eq("docId", args.docId)
						.eq("type", change.type)
						.eq("hash", hash),
				)
				.first();
			if (existingByHash) {
				serverCursor = Math.max(serverCursor, existingByHash._creationTime);
				continue;
			}

			const id = await ctx.db.insert("automergeChanges", {
				docId: args.docId,
				type: change.type,
				hash,
				data: change.data,
				clientId: args.clientId,
				idempotencyKey: args.idempotencyKey,
			});
			const row = await ctx.db.get(id);
			if (row) {
				serverCursor = Math.max(serverCursor, row._creationTime);
			}
			inserted += 1;
		}

		return {
			ok: true as const,
			duplicate: false as const,
			inserted,
			serverCursor,
		};
	},
});

export const pullChanges = query({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		sinceCursor: v.number(),
		numItems: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);

		const result = await ctx.db
			.query("automergeChanges")
			.withIndex("by_docId", (q) =>
				q.eq("docId", args.docId).gt("_creationTime", args.sinceCursor),
			)
			.paginate({
				numItems: clampPageSize(args.numItems),
				cursor: args.cursor ?? null,
			});

		return {
			...result,
			page: result.page.map((change) => ({
				id: change._id,
				docId: change.docId,
				type: change.type,
				hash: change.hash,
				data: change.data,
				clientId: change.clientId,
				idempotencyKey: change.idempotencyKey,
				serverCursor: change._creationTime,
			})),
		};
	},
});

export const getLatestCursor = query({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const latest = await ctx.db
			.query("automergeChanges")
			.withIndex("by_docId", (q) => q.eq("docId", args.docId))
			.order("desc")
			.first();
		return latest?._creationTime ?? 0;
	},
});

export const getOrCreateDocIdForPath = mutation({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		candidateDocId: v.string(),
		clientId: v.string(),
		updatedAtMs: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizePath(args.path);
		const existing = await ctx.db
			.query("automergeDocPaths")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (existing) {
			if (existing.deletedAtMs !== undefined) {
				await ctx.db.patch(existing._id, {
					docId: args.candidateDocId,
					createdByClientId: args.clientId,
					updatedAtMs: args.updatedAtMs,
					deletedAtMs: undefined,
				});
				return {
					docId: args.candidateDocId,
					created: true as const,
				};
			}
			return {
				docId: existing.docId,
				created: false as const,
			};
		}
		await ctx.db.insert("automergeDocPaths", {
			path,
			docId: args.candidateDocId,
			createdByClientId: args.clientId,
			updatedAtMs: args.updatedAtMs,
		});
		return {
			docId: args.candidateDocId,
			created: true as const,
		};
	},
});

export const renameDocPath = mutation({
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
		const existingOld = await ctx.db
			.query("automergeDocPaths")
			.withIndex("by_path", (q) => q.eq("path", oldPath))
			.unique();
		if (!existingOld) {
			return { ok: false as const, reason: "old_path_missing" as const };
		}
		const existingNew = await ctx.db
			.query("automergeDocPaths")
			.withIndex("by_path", (q) => q.eq("path", newPath))
			.unique();
		if (existingNew && existingNew.docId !== existingOld.docId) {
			return {
				ok: false as const,
				reason: "path_conflict" as const,
				conflictingDocId: existingNew.docId,
			};
		}
		await ctx.db.patch(existingOld._id, {
			path: newPath,
			updatedAtMs: args.updatedAtMs,
			createdByClientId: args.clientId,
			deletedAtMs: undefined,
		});
		return { ok: true as const, docId: existingOld.docId };
	},
});

export const deleteDocPath = mutation({
	args: {
		convexSecret: v.string(),
		path: v.string(),
		clientId: v.string(),
		deletedAtMs: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const path = normalizePath(args.path);
		const existing = await ctx.db
			.query("automergeDocPaths")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (!existing) {
			return { ok: true as const, deleted: false as const };
		}
		await ctx.db.patch(existing._id, {
			updatedAtMs: args.deletedAtMs,
			createdByClientId: args.clientId,
			deletedAtMs: args.deletedAtMs,
		});
		return { ok: true as const, deleted: true as const, docId: existing.docId };
	},
});

export const listDocPathChanges = query({
	args: {
		convexSecret: v.string(),
		sinceUpdatedAtMs: v.number(),
		numItems: v.optional(v.number()),
		cursor: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const result = await ctx.db
			.query("automergeDocPaths")
			.filter((q) => q.gt(q.field("updatedAtMs"), args.sinceUpdatedAtMs))
			.paginate({
				numItems: clampPageSize(args.numItems),
				cursor: args.cursor ?? null,
			});
		return {
			...result,
			page: result.page.map((row) => ({
				path: row.path,
				docId: row.docId,
				updatedAtMs: row.updatedAtMs,
				deletedAtMs: row.deletedAtMs ?? null,
			})),
		};
	},
});

function clampPageSize(numItems: number | undefined): number {
	if (numItems === undefined) {
		return DEFAULT_PAGE_SIZE;
	}
	return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(numItems)));
}

function maxCreationTime(
	rows: Array<{
		_creationTime: number;
	}>,
): number {
	return rows.reduce((max, row) => Math.max(max, row._creationTime), 0);
}

function hashBytes(binary: Uint8Array): string {
	const hash = sha256(binary);
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizePath(input: string): string {
	return input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}
