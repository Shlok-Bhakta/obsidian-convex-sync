import { authedQuery } from "./_lib/auth";

export const get = authedQuery({}, async (ctx: any, args: any) => {
		void args;
		return await ctx.db.query("tasks").collect();
	});

/** One task chosen at random on the server, or `null` if the table is empty. */
export const getRandom = authedQuery({}, async (ctx: any, args: any) => {
		void args;
		const tasks = await ctx.db.query("tasks").collect();
		if (tasks.length === 0) {
			return null;
		}
		const index = Math.floor(Math.random() * tasks.length);
		return tasks[index] ?? null;
	});
