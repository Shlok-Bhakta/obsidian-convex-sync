import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const noStoreHeaders = {
	"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
	Pragma: "no-cache",
	Expires: "0",
} as const;

const jsonHeaders = {
	...noStoreHeaders,
	"Content-Type": "application/json; charset=utf-8",
} as const;

const http = httpRouter();

http.route({
	path: "/obsidian-convex-sync/mint-vault-api-secret",
	method: "OPTIONS",
	handler: httpAction(async () => {
		return new Response(null, {
			status: 204,
			headers: {
				...noStoreHeaders,
				"Access-Control-Allow-Origin": "*",
				"Access-Control-Allow-Methods": "POST, OPTIONS",
				"Access-Control-Allow-Headers": "Content-Type",
				"Access-Control-Max-Age": "86400",
			},
		});
	}),
});

http.route({
	path: "/obsidian-convex-sync/mint-vault-api-secret",
	method: "POST",
	handler: httpAction(async (ctx) => {
		const result = await ctx.runAction(
			internal.pluginSecretMint.generateAndClaimIfEmpty,
			{},
		);
		const status = result.ok ? 200 : 403;
		return new Response(JSON.stringify(result), {
			status,
			headers: {
				...jsonHeaders,
				"Access-Control-Allow-Origin": "*",
			},
		});
	}),
});

http.route({
	path: "/obsidian-convex-sync/bootstrap-download",
	method: "GET",
	handler: httpAction(async (ctx, request) => {
		const url = new URL(request.url);
		const token = url.searchParams.get("token") ?? "";
		if (!token) {
			return new Response("Missing token", { status: 400, headers: noStoreHeaders });
		}
		const resolved = await ctx.runQuery(internal.bootstrap.resolveDownloadByToken, {
			token,
		});
		if (!resolved) {
			return new Response("Bootstrap link expired or invalid", {
				status: 404,
				headers: noStoreHeaders,
			});
		}
		const blob = await ctx.storage.get(resolved.storageId);
		if (!blob) {
			return new Response("Archive not found", {
				status: 404,
				headers: noStoreHeaders,
			});
		}
		return new Response(blob.stream(), {
			status: 200,
			headers: {
				...noStoreHeaders,
				"Content-Type": "application/zip",
				"Content-Disposition": `attachment; filename="${resolved.archiveName}"`,
			},
		});
	}),
});

export default http;
