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
