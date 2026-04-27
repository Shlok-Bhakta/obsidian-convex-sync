import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requirePluginSecret } from "./security";

const TEN_MINUTES_MS = 10 * 60_000;

type BootstrapRow = {
	_id: string;
	storageId?: string;
	downloadToken?: string;
	archiveName?: string;
	status: "building" | "ready" | "expired" | "failed";
};

async function getSingletonRow(ctx: any): Promise<any | null> {
	const rows = await ctx.db.query("vaultBootstraps").collect();
	return rows[0] ?? null;
}

async function cleanupBootstrapStorage(ctx: any, row: BootstrapRow | null): Promise<void> {
	if (row?.storageId) {
		await ctx.storage.delete(row.storageId as never);
	}
}

function sanitizeVaultName(vaultName: string): string {
	return vaultName
		.trim()
		.replace(/[^\w.-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

export const startBuild = mutation({
	args: {
		convexSecret: v.string(),
		clientId: v.string(),
		vaultName: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		if (args.clientId.trim() === "") {
			throw new ConvexError("clientId is required.");
		}

		const existing = await getSingletonRow(ctx);
		if (existing) {
			await cleanupBootstrapStorage(ctx, existing);
			await ctx.db.delete(existing._id);
		}

		const allFiles = await ctx.db.query("vaultFiles").collect();
		const bytesTotal = allFiles.reduce((sum, file) => sum + file.sizeBytes, 0);

		const cleanVaultName = sanitizeVaultName(args.vaultName);
		const archiveName = `${cleanVaultName || "obsidian-vault"}.zip`;
		const rowId = await ctx.db.insert("vaultBootstraps", {
			status: "building",
			phase: "Queued",
			filesProcessed: 0,
			filesTotal: allFiles.length,
			bytesProcessed: 0,
			bytesTotal,
			archiveName,
			startedAtMs: Date.now(),
			createdByClientId: args.clientId,
		});

		await ctx.scheduler.runAfter(0, internal.bootstrapArchive.buildArchive, {
			bootstrapId: rowId,
			convexSecret: args.convexSecret,
			vaultName: args.vaultName,
		});
		return { ok: true as const };
	},
});

export const getStatus = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const row = await getSingletonRow(ctx);
		if (!row) {
			return { status: "idle" as const };
		}
		let downloadUrl: string | null = null;
		if (
			row.status === "ready" &&
			row.downloadToken &&
			typeof row.expiresAtMs === "number" &&
			row.expiresAtMs > Date.now()
		) {
			downloadUrl = `/obsidian-convex-sync/bootstrap-download?token=${encodeURIComponent(row.downloadToken)}`;
		}
		return {
			status: row.status,
			phase: row.phase,
			filesProcessed: row.filesProcessed,
			filesTotal: row.filesTotal,
			bytesProcessed: row.bytesProcessed,
			bytesTotal: row.bytesTotal,
			sizeBytes: row.sizeBytes ?? null,
			contentHash: row.contentHash ?? null,
			readyAtMs: row.readyAtMs ?? null,
			expiresAtMs: row.expiresAtMs ?? null,
			errorMessage: row.errorMessage ?? null,
			archiveName: row.archiveName ?? null,
			downloadUrl,
		};
	},
});

export const cancelBootstrap = mutation({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const row = await getSingletonRow(ctx);
		if (!row) {
			return { ok: true as const };
		}
		await cleanupBootstrapStorage(ctx, row);
		await ctx.db.patch(row._id, {
			status: "expired",
			phase: "Cancelled",
			storageId: undefined,
			downloadToken: undefined,
			expiresAtMs: Date.now(),
		});
		return { ok: true as const };
	},
});

/** Allocates a one-shot upload URL for the bootstrap ZIP (used by the Node archive action). */
export const issueZipUploadUrl = internalMutation({
	args: { bootstrapId: v.id("vaultBootstraps") },
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.bootstrapId);
		if (!row || row.status !== "building") {
			throw new ConvexError("Bootstrap is not in a building state.");
		}
		const uploadUrl = await ctx.storage.generateUploadUrl();
		return { uploadUrl };
	},
});

export const updateProgress = internalMutation({
	args: {
		bootstrapId: v.id("vaultBootstraps"),
		phase: v.string(),
		filesProcessed: v.number(),
		bytesProcessed: v.number(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.bootstrapId);
		if (!row || row.status !== "building") {
			return;
		}
		await ctx.db.patch(args.bootstrapId, {
			phase: args.phase,
			filesProcessed: args.filesProcessed,
			bytesProcessed: args.bytesProcessed,
		});
	},
});

export const finalizeArchive = internalMutation({
	args: {
		bootstrapId: v.id("vaultBootstraps"),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		sizeBytes: v.number(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.bootstrapId);
		if (!row) {
			await ctx.storage.delete(args.storageId);
			return;
		}
		if (row.storageId && row.storageId !== args.storageId) {
			await ctx.storage.delete(row.storageId);
		}
		await ctx.db.patch(args.bootstrapId, {
			status: "ready",
			phase: "Ready",
			storageId: args.storageId,
			downloadToken: crypto.randomUUID(),
			contentHash: args.contentHash,
			sizeBytes: args.sizeBytes,
			filesProcessed: row.filesTotal,
			bytesProcessed: row.bytesTotal,
			readyAtMs: Date.now(),
			expiresAtMs: Date.now() + TEN_MINUTES_MS,
			errorMessage: undefined,
		});
		await ctx.scheduler.runAfter(TEN_MINUTES_MS, internal.bootstrap.expireBootstrap, {
			bootstrapId: args.bootstrapId,
		});
	},
});

export const failBuild = internalMutation({
	args: {
		bootstrapId: v.id("vaultBootstraps"),
		message: v.string(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.bootstrapId);
		if (!row) {
			return;
		}
		await cleanupBootstrapStorage(ctx, row);
		await ctx.db.patch(args.bootstrapId, {
			status: "failed",
			phase: "Failed",
			storageId: undefined,
			downloadToken: undefined,
			errorMessage: args.message,
		});
	},
});

export const expireBootstrap = internalMutation({
	args: { bootstrapId: v.id("vaultBootstraps") },
	handler: async (ctx, args) => {
		const row = await ctx.db.get(args.bootstrapId);
		if (!row) {
			return;
		}
		await cleanupBootstrapStorage(ctx, row);
		await ctx.db.patch(args.bootstrapId, {
			status: "expired",
			phase: "Expired",
			storageId: undefined,
			downloadToken: undefined,
		});
	},
});

export const resolveDownloadByToken = internalQuery({
	args: { token: v.string() },
	handler: async (ctx, args) => {
		const rows = await ctx.db.query("vaultBootstraps").collect();
		const row = rows.find((entry) => entry.downloadToken === args.token);
		if (!row || row.status !== "ready") {
			return null;
		}
		if (!row.storageId || !row.archiveName || !row.expiresAtMs) {
			return null;
		}
		if (Date.now() >= row.expiresAtMs) {
			return null;
		}
		return {
			storageId: row.storageId,
			archiveName: row.archiveName,
			expiresAtMs: row.expiresAtMs,
		};
	},
});

export const _readSnapshot = internalQuery({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const files = await ctx.db.query("vaultFiles").collect();
		return {
			files: files.map((row) => ({
				path: row.path,
				isText: row.isText,
				storageId: row.storageId,
				sizeBytes: row.sizeBytes,
			})),
		};
	},
});
