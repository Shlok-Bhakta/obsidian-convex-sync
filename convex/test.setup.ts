import { convexTest } from "convex-test";
import schema from "./schema";

export const modules = import.meta.glob([
	"./**/*.ts",
	"!./**/*.test.ts",
	"!./test.setup.ts",
	"!./test.helpers.ts",
]);

export function makeConvexTest() {
	return convexTest(schema, modules);
}

export async function seedPluginSecret(
	t: ReturnType<typeof makeConvexTest>,
	secret = "test-secret",
): Promise<string> {
	await t.run(async (ctx) => {
		const existing = await ctx.db.query("pluginAuth").first();
		if (existing) {
			return;
		}
		await ctx.db.insert("pluginAuth", { secret });
	});
	return secret;
}
