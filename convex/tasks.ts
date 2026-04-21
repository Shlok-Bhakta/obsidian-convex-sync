import { v } from "convex/values";
import { query } from "./_generated/server";
import { requirePluginSecret } from "./security";

export const get = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		return await ctx.db.query("tasks").collect();
	},
});

/** One task chosen at random on the server, or `null` if the table is empty. */
export const getRandom = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const tasks = await ctx.db.query("tasks").collect();
		if (tasks.length === 0) {
			return null;
		}
		const index = Math.floor(Math.random() * tasks.length);
		return tasks[index] ?? null;
	},
});
