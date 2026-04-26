import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requirePluginSecret } from "./security";

const MAX_UPDATES_PER_DOC = 500;

export const pushAwarenessUpdate = mutation({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
		update: v.bytes(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		if (args.docId.trim() === "") {
			throw new ConvexError("docId is required.");
		}
		await ctx.db.insert("yjsAwarenessUpdates", {
			docId: args.docId,
			update: args.update,
		});

		const rows = await ctx.db
			.query("yjsAwarenessUpdates")
			.withIndex("by_docId", (q) => q.eq("docId", args.docId))
			.collect();
		if (rows.length > MAX_UPDATES_PER_DOC) {
			rows.sort((a, b) => a._creationTime - b._creationTime);
			const overflow = rows.length - MAX_UPDATES_PER_DOC;
			const oldest = rows.slice(0, overflow);
			for (const r of oldest) {
				await ctx.db.delete(r._id);
			}
		}
	},
});

export const listAwarenessUpdates = query({
	args: {
		convexSecret: v.string(),
		docId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		if (args.docId.trim() === "") {
			return [];
		}
		const rows = await ctx.db
			.query("yjsAwarenessUpdates")
			.withIndex("by_docId", (q) => q.eq("docId", args.docId))
			.collect();
		rows.sort((a, b) => a._creationTime - b._creationTime);
		return rows.map((r) => ({ _id: r._id, update: r.update }));
	},
});
