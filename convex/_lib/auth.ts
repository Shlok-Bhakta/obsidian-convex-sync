import { v } from "convex/values";
import { mutation, query } from "../_generated/server";
import { requirePluginSecret } from "../security";

export function authedQuery(args: any, handler: any) {
	return query({
		args: { ...(args ?? {}), convexSecret: v.string() } as any,
		handler: async (ctx, callArgs) => {
			await requirePluginSecret(ctx as any, (callArgs as any).convexSecret);
			return handler(ctx, callArgs);
		},
	});
}

export function authedMutation(args: any, handler: any) {
	return mutation({
		args: { ...(args ?? {}), convexSecret: v.string() } as any,
		handler: async (ctx, callArgs) => {
			await requirePluginSecret(ctx as any, (callArgs as any).convexSecret);
			return handler(ctx, callArgs);
		},
	});
}
