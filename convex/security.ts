import { ConvexError, v } from "convex/values";
import {
	internalMutation,
	internalQuery,
	mutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/**
 * Inserts {@link args.secret} as the deployment vault API key only when the table
 * has no rows yet. Used exclusively from {@link internal.pluginSecretMint.generateAndClaimIfEmpty}.
 */
export const claimInitialPluginSecret = internalMutation({
	args: { secret: v.string() },
	returns: v.union(
		v.object({ ok: v.literal(true) }),
		v.object({
			ok: v.literal(false),
			error: v.literal("uuid_already_registered"),
		}),
	),
	handler: async (ctx, args) => {
		const rows = await ctx.db.query("pluginAuth").take(1);
		if (rows.length > 0) {
			return {
				ok: false as const,
				error: "uuid_already_registered" as const,
			};
		}
		await ctx.db.insert("pluginAuth", { secret: args.secret });
		return { ok: true as const };
	},
});

export const validatePluginSecret = internalQuery({
	args: { secret: v.string() },
	handler: async (ctx, args) => {
		const rows = await ctx.db.query("pluginAuth").take(1);
		const row = rows[0];
		if (!row) {
			return { ok: false as const, reason: "not_configured" as const };
		}
		if (row.secret !== args.secret) {
			return { ok: false as const, reason: "invalid" as const };
		}
		return { ok: true as const };
	},
});

/**
 * Throws if the client secret does not match the single stored deployment secret.
 * Call from every public query/mutation except {@link registerPluginSecret}.
 */
export async function requirePluginSecret(
	ctx: QueryCtx | MutationCtx,
	secret: string,
): Promise<void> {
	const result = await ctx.runQuery(internal.security.validatePluginSecret, {
		secret,
	});
	if (!result.ok) {
		if (result.reason === "not_configured") {
			throw new ConvexError(
				"No vault API key is registered for this Convex deployment yet. Reload the plugin or run registration from settings.",
			);
		}
		throw new ConvexError(
			"The vault API key does not match the one registered for this deployment. Check that this vault uses the same Obsidian plugin data as the vault that first connected, or reset pluginAuth in Convex if you are starting over.",
		);
	}
}

/**
 * One-time (per deployment) registration: if `pluginAuth` is empty, stores the secret.
 * If a secret already exists, accepts only the same secret; otherwise returns a clear error.
 * Does not call {@link requirePluginSecret}.
 */
export const registerPluginSecret = mutation({
	args: { proposedSecret: v.string() },
	handler: async (ctx, args) => {
		if (args.proposedSecret.trim() === "") {
			return {
				ok: false as const,
				message: "Vault API key is empty. Mint a key in plugin settings first.",
			};
		}
		const rows = await ctx.db.query("pluginAuth").take(1);
		const existing = rows[0];
		if (!existing) {
			await ctx.db.insert("pluginAuth", { secret: args.proposedSecret });
			return { ok: true as const, kind: "registered" as const };
		}
		if (existing.secret === args.proposedSecret) {
			return { ok: true as const, kind: "already_registered" as const };
		}
		return {
			ok: false as const,
			message:
				"This Convex deployment already has a vault API key from another Obsidian vault. The key from this vault does not match. Use the original vault, copy its plugin data, or delete the pluginAuth document in the Convex dashboard if you intentionally want to replace the key.",
		};
	},
});
