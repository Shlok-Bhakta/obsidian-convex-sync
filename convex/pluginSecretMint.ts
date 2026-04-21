"use node";

import { randomUUID } from "node:crypto";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { v } from "convex/values";

const mintResultValidator = v.union(
	v.object({ ok: v.literal(true), secret: v.string() }),
	v.object({
		ok: v.literal(false),
		error: v.literal("uuid_already_registered"),
		message: v.string(),
	}),
);

/**
 * Generates a vault API key with Node's crypto and persists it only when
 * {@link pluginAuth} is still empty (see {@link internal.security.claimInitialPluginSecret}).
 */
export const generateAndClaimIfEmpty = internalAction({
	args: {},
	returns: mintResultValidator,
	handler: async (ctx) => {
		const secret = randomUUID();
		const result = await ctx.runMutation(
			internal.security.claimInitialPluginSecret,
			{ secret },
		);
		if (result.ok) {
			return { ok: true as const, secret };
		}
		return {
			ok: false as const,
			error: "uuid_already_registered" as const,
			message:
				"Access denied: uuid already registered for this deployment.",
		};
	},
});
