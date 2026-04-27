import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"y-internal-y-sync": path.join(
				__dirname,
				"node_modules/y-codemirror.next/src/y-sync.js",
			),
		},
	},
});
