import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const automergeTestShim = fileURLToPath(
	new URL("./convex/test.automerge.ts", import.meta.url),
);

export default defineConfig({
	resolve: {
		alias: [
			{
				find: "../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_workerd.js",
				replacement: automergeTestShim,
			},
			{
				find: "../../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_workerd.js",
				replacement: automergeTestShim,
			},
		],
	},
	test: {
		include: ["convex/**/*.test.ts"],
		environment: "edge-runtime",
	},
});
