// Convex runs in a workerd-style runtime, so we force the workerd Automerge entrypoint here.
// @ts-expect-error Convex's TS program does not pick up declarations for this private path.
import * as Automerge from "../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_workerd.js";
import { ConvexError, v } from "convex/values";
import { zipSync } from "fflate";
import { internal } from "./_generated/api";
import {
	internalAction,
	internalMutation,
	internalQuery,
	mutation,
	query,
} from "./_generated/server";
import { requirePluginSecret } from "./security";

const TEN_MINUTES_MS = 10 * 60_000;

type TextDoc = { text: string };

type BootstrapRow = {
	_id: string;
	storageId?: string;
	downloadToken?: string;
	archiveName?: string;
	status: "building" | "ready" | "expired" | "failed";
};

type BootstrapFileEntry =
	| {
			kind: "text";
			docId: string;
			path: string;
			sizeBytes: number;
	  }
	| {
			kind: "binary";
			docId: string;
			path: string;
			storageId: string;
			sizeBytes: number;
	  }
	| {
			kind: "legacyBinary";
			path: string;
			storageId: string;
			sizeBytes: number;
	  };

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function emptyDoc(): Automerge.Doc<TextDoc> {
	return Automerge.init<TextDoc>();
}

function toUint8Array(bytes: ArrayBuffer | Uint8Array): Uint8Array {
	return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function docText(doc: Automerge.Doc<TextDoc>): string {
	const value = (doc as { text?: unknown }).text;
	if (typeof value === "string") {
		return value;
	}
	if (value && typeof (value as { toString(): string }).toString === "function") {
		return (value as { toString(): string }).toString();
	}
	return "";
}

async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return toHex(digest);
}

async function getSingletonRow(ctx: any): Promise<any | null> {
	const rows = await ctx.db.query("vaultBootstraps").collect();
	return rows[0] ?? null;
}

async function cleanupBootstrapStorage(ctx: any, row: BootstrapRow | null): Promise<void> {
	if (row?.storageId) {
		await ctx.storage.delete(row.storageId as never);
	}
}

async function latestSnapshotForDoc(ctx: any, docId: string) {
	const rows = await ctx.db
		.query("docSnapshots")
		.withIndex("by_doc_seq", (q: any) => q.eq("docId", docId))
		.order("desc")
		.take(1);
	return rows[0] ?? null;
}

async function latestBinaryForDoc(ctx: any, docId: string) {
	const rows = await ctx.db
		.query("binaryVersions")
		.withIndex("by_doc_time", (q: any) => q.eq("docId", docId))
		.order("desc")
		.take(1);
	return rows[0] ?? null;
}

async function buildDocsSnapshot(ctx: any): Promise<BootstrapFileEntry[]> {
	const docs = await ctx.db.query("docs").collect();
	const activeDocs = docs
		.filter((doc: any) => !doc.deletedAtMs && doc.kind !== "folder")
		.sort((a: any, b: any) => a.path.localeCompare(b.path));
	const files: BootstrapFileEntry[] = [];
	for (const doc of activeDocs) {
		if (doc.kind === "binary") {
			const binary = await latestBinaryForDoc(ctx, doc.docId);
			if (!binary) {
				continue;
			}
			files.push({
				kind: "binary",
				docId: doc.docId,
				path: doc.path,
				storageId: binary.storageId,
				sizeBytes: binary.sizeBytes,
			});
			continue;
		}
		const snapshot = await latestSnapshotForDoc(ctx, doc.docId);
		const ops = await ctx.db
			.query("docOps")
			.withIndex("by_doc_seq", (q: any) => q.eq("docId", doc.docId))
			.collect();
		const deltaBytes = ops
			.filter((op: any) => op.seq > (snapshot?.upToSeq ?? 0))
			.reduce(
				(total: number, op: any) => total + op.changeBytes.byteLength,
				0,
			);
		files.push({
			kind: "text",
			docId: doc.docId,
			path: doc.path,
			sizeBytes: (snapshot?.sizeBytes ?? 0) + deltaBytes,
		});
	}
	return files;
}

async function readBootstrapFiles(ctx: any): Promise<BootstrapFileEntry[]> {
	const docFiles = await buildDocsSnapshot(ctx);
	if (docFiles.length > 0) {
		return docFiles;
	}
	const legacyFiles = await ctx.db.query("vaultFiles").collect();
	return legacyFiles
		.sort((a: any, b: any) => a.path.localeCompare(b.path))
		.map((row: any) => ({
			kind: "legacyBinary" as const,
			path: row.path,
			storageId: row.storageId,
			sizeBytes: row.sizeBytes,
		}));
}

async function materializeTextDoc(ctx: any, docId: string): Promise<Uint8Array> {
	const payload = await ctx.runQuery(internal.sync.getCompactionPayload, { docId });
	if (!payload) {
		return new TextEncoder().encode("");
	}
	let doc = emptyDoc();
	if (payload.snapshot?.storageId) {
		const blob = await ctx.storage.get(payload.snapshot.storageId);
		if (blob) {
			doc = Automerge.load<TextDoc>(new Uint8Array(await blob.arrayBuffer()));
		}
	}
	if (payload.ops.length > 0) {
		doc = Automerge.applyChanges(
			doc,
			payload.ops.map((op: any) => toUint8Array(op.changeBytes)),
		)[0];
	}
	return new TextEncoder().encode(docText(doc));
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

		const files = await readBootstrapFiles(ctx);
		const bytesTotal = files.reduce((sum, file) => sum + file.sizeBytes, 0);

		const cleanVaultName = args.vaultName
			.trim()
			.replace(/[^\w.-]+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
		const archiveName = `${cleanVaultName || "obsidian-vault"}.zip`;
		const rowId = await ctx.db.insert("vaultBootstraps", {
			status: "building",
			phase: "Queued",
			filesProcessed: 0,
			filesTotal: files.length,
			bytesProcessed: 0,
			bytesTotal,
			archiveName,
			startedAtMs: Date.now(),
			createdByClientId: args.clientId,
		});

		await ctx.scheduler.runAfter(0, internal.bootstrap.buildArchive, {
			bootstrapId: rowId,
			convexSecret: args.convexSecret,
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
		if (!row || row.status !== "building") {
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

export const buildArchive = internalAction({
	args: {
		bootstrapId: v.id("vaultBootstraps"),
		convexSecret: v.string(),
	},
	handler: async (ctx, args) => {
		try {
			const snapshot = await ctx.runQuery(internal.bootstrap._readSnapshot, {
				convexSecret: args.convexSecret,
			});
			const archiveEntries: Record<string, Uint8Array> = {};
			let filesProcessed = 0;
			let bytesProcessed = 0;
			const chunkInterval = 8;

			for (const row of snapshot.files) {
				let bytes: Uint8Array | null = null;
				if (row.kind === "text") {
					bytes = await materializeTextDoc(ctx, row.docId);
				} else {
					const blob = await ctx.storage.get(row.storageId);
					if (blob) {
						bytes = new Uint8Array(await blob.arrayBuffer());
					}
				}
				if (!bytes) {
					continue;
				}
				archiveEntries[row.path] = bytes;
				filesProcessed += 1;
				bytesProcessed += row.sizeBytes;
				if (filesProcessed % chunkInterval === 0) {
					await ctx.runMutation(internal.bootstrap.updateProgress, {
						bootstrapId: args.bootstrapId,
						phase: `Collecting vault files (${filesProcessed}/${snapshot.files.length})`,
						filesProcessed,
						bytesProcessed,
					});
				}
			}

			await ctx.runMutation(internal.bootstrap.updateProgress, {
				bootstrapId: args.bootstrapId,
				phase: "Compressing archive",
				filesProcessed,
				bytesProcessed,
			});
			const zipped = zipSync(archiveEntries, { level: 6 });
			const zipBytes = zipped.buffer.slice(
				zipped.byteOffset,
				zipped.byteOffset + zipped.byteLength,
			) as ArrayBuffer;
			const contentHash = await sha256Bytes(zipBytes);
			const storageId = await ctx.storage.store(new Blob([zipBytes], { type: "application/zip" }));
			await ctx.runMutation(internal.bootstrap.finalizeArchive, {
				bootstrapId: args.bootstrapId,
				storageId,
				contentHash,
				sizeBytes: zipped.byteLength,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await ctx.runMutation(internal.bootstrap.failBuild, {
				bootstrapId: args.bootstrapId,
				message,
			});
		}
	},
});

export const _readSnapshot = internalQuery({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		return {
			files: await readBootstrapFiles(ctx),
		};
	},
});
