import { Migrations } from "@convex-dev/migrations";
import { components } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { isBinaryPath, legacyDocIdForPath, normalizeVaultPath } from "./_lib/sync";

const migrations = new Migrations<DataModel>(components.migrations);

export const backfillVaultFiles = migrations.define({
	table: "vaultFiles",
	batchSize: 10,
	migrateOne: async (ctx, row) => {
		const path = normalizeVaultPath(row.path);
		const existing = await ctx.db
			.query("docs")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (existing) {
			return;
		}
		const docId = legacyDocIdForPath(path);
		const kind = isBinaryPath(path) ? "binary" : "text";
		await ctx.db.insert("docs", {
			docId,
			kind,
			path,
			createdAtMs: row.updatedAtMs,
			createdByClientId: row.updatedByClientId,
			updatedAtMs: row.updatedAtMs,
			updatedByClientId: row.updatedByClientId,
			latestSeq: 0,
		});
		if (kind === "binary") {
			await ctx.db.insert("binaryVersions", {
				docId,
				storageId: row.storageId,
				contentHash: row.contentHash,
				sizeBytes: row.sizeBytes,
				updatedAtMs: row.updatedAtMs,
				updatedByClientId: row.updatedByClientId,
			});
			return;
		}
	},
});

export const backfillVaultFolders = migrations.define({
	table: "vaultFolders",
	migrateOne: async (ctx, row) => {
		const path = normalizeVaultPath(row.path);
		const existing = await ctx.db
			.query("docs")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (existing) {
			return;
		}
		await ctx.db.insert("docs", {
			docId: legacyDocIdForPath(path),
			kind: "folder",
			path,
			createdAtMs: row.updatedAtMs,
			createdByClientId: row.updatedByClientId ?? "migration",
			updatedAtMs: row.updatedAtMs,
			updatedByClientId: row.updatedByClientId ?? "migration",
			latestSeq: 0,
		});
	},
});

export const backfillVaultBundle = migrations.define({
	table: "vaultBundles",
	migrateOne: async (ctx, row) => {
		const path = ".obsidian.bundle.zip";
		const existing = await ctx.db
			.query("docs")
			.withIndex("by_path", (q) => q.eq("path", path))
			.unique();
		if (existing) {
			return;
		}
		const docId = legacyDocIdForPath(path);
		await ctx.db.insert("docs", {
			docId,
			kind: "binary",
			path,
			createdAtMs: row.updatedAtMs,
			createdByClientId: row.updatedByClientId,
			updatedAtMs: row.updatedAtMs,
			updatedByClientId: row.updatedByClientId,
			latestSeq: 0,
		});
		await ctx.db.insert("binaryVersions", {
			docId,
			storageId: row.storageId,
			contentHash: row.contentHash,
			sizeBytes: row.sizeBytes,
			updatedAtMs: row.updatedAtMs,
			updatedByClientId: row.updatedByClientId,
		});
	},
});

export const run = migrations.runner();
