import { ConvexError, v } from "convex/values";
import {
	internalMutation,
	mutation,
	query,
} from "./_generated/server";
import { requirePluginSecret } from "./security";

/** Three missed 10s heartbeats */
const STALE_MS = 30_000;

const editorPosition = v.object({
	line: v.number(),
	ch: v.number(),
});

const editorCursor = v.object({
	anchor: editorPosition,
	head: editorPosition,
	from: editorPosition,
	to: editorPosition,
});

const emptyCursor = {
	anchor: { line: 0, ch: 0 },
	head: { line: 0, ch: 0 },
	from: { line: 0, ch: 0 },
	to: { line: 0, ch: 0 },
};

export const listActive = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const now = Date.now();
		const rows = await ctx.db.query("clientPresence").collect();
		return rows
			.filter((r) => now - r.lastHeartbeatAt <= STALE_MS)
			.map((r) => ({
				clientId: r.clientId,
				openFilePath: r.openFilePath,
				cursor: r.cursor,
				lastHeartbeatAt: r.lastHeartbeatAt,
			}))
			.sort((a, b) => a.clientId.localeCompare(b.clientId));
	},
});

export const heartbeat = mutation({
	args: {
		convexSecret: v.string(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		if (args.clientId.trim() === "") {
			throw new ConvexError("clientId is required.");
		}
		const now = Date.now();
		const existing = await ctx.db
			.query("clientPresence")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (existing) {
			await ctx.db.patch(existing._id, { lastHeartbeatAt: now });
		} else {
			await ctx.db.insert("clientPresence", {
				clientId: args.clientId,
				openFilePath: "",
				cursor: emptyCursor,
				lastHeartbeatAt: now,
			});
		}
	},
});

export const updateEditorPresence = mutation({
	args: {
		convexSecret: v.string(),
		clientId: v.string(),
		openFilePath: v.string(),
		cursor: editorCursor,
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		if (args.clientId.trim() === "") {
			throw new ConvexError("clientId is required.");
		}
		const existing = await ctx.db
			.query("clientPresence")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (!existing) {
			return;
		}
		await ctx.db.patch(existing._id, {
			openFilePath: args.openFilePath,
			cursor: args.cursor,
		});
	},
});

export const leave = mutation({
	args: {
		convexSecret: v.string(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		if (args.clientId.trim() === "") {
			return;
		}
		const existing = await ctx.db
			.query("clientPresence")
			.withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
			.unique();
		if (existing) {
			await ctx.db.delete(existing._id);
		}
	},
});

export const removeStalePresence = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const rows = await ctx.db.query("clientPresence").collect();
		for (const row of rows) {
			if (now - row.lastHeartbeatAt > STALE_MS) {
				await ctx.db.delete(row._id);
			}
		}
	},
});
