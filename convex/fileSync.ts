import { ConvexError, v } from "convex/values";
import {
	internalMutation,
	mutation,
	query,
} from "./_generated/server";
import {
	FILE_WAL_COMPACTION_BYTES_THRESHOLD,
	FILE_WAL_COMPACTION_OP_THRESHOLD,
	FILE_WAL_COMPACTION_STALE_MS,
	shouldCompactFileHistory,
} from "./_lib/fileSyncEngine";
import {
	decideBinaryCommit,
	decideDeleteCommit,
	decideRenameCommit,
	decideTextCommit,
} from "./_lib/fileSyncProtocol";
import { requirePluginSecret } from "./security";

const contentKindValidator = v.union(v.literal("text"), v.literal("binary"));
const changeKindValidator = v.union(v.literal("upsert"), v.literal("rename"), v.literal("delete"));
const conflictTypeValidator = v.union(
	v.literal("text"),
	v.literal("binary"),
	v.literal("rename"),
	v.literal("delete"),
	v.literal("stale_base"),
);

const SYNC_HEAD_SINGLETON_KEY = "main";
const ACTIVE_CLIENT_WINDOW_MS = 5 * 60 * 1000;
const FILE_WAL_RETENTION_MAX_MS = 30 * 24 * 60 * 60 * 1000;

function normalizePath(input: string): string {
	const normalized = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (normalized.includes("..")) {
		throw new ConvexError("Path traversal is not allowed.");
	}
	return normalized;
}

function clampCommittedAt(input: number): number {
	return Math.min(input, Date.now());
}

function serializeManifest(manifest: any) {
	return {
		fileId: manifest.fileId,
		path: manifest.path,
		revision: manifest.revision,
		deleted: manifest.deleted,
		contentHash: manifest.contentHash ?? null,
		sizeBytes: manifest.sizeBytes ?? null,
		contentKind: manifest.contentKind ?? null,
		updatedAtMs: manifest.updatedAtMs,
		updatedByClientId: manifest.updatedByClientId,
		latestSnapshotRevision: manifest.latestSnapshotRevision ?? null,
	};
}

async function getManifestByFileId(ctx: any, fileId: string): Promise<any | null> {
	return await ctx.db
		.query("fileManifests")
		.withIndex("by_fileId", (q: any) => q.eq("fileId", fileId))
		.unique();
}

async function getManifestByPath(ctx: any, path: string): Promise<any | null> {
	return await ctx.db
		.query("fileManifests")
		.withIndex("by_path", (q: any) => q.eq("path", path))
		.unique();
}

async function getRevisionRows(ctx: any, fileId: string): Promise<any[]> {
	const rows = await ctx.db
		.query("fileRevisions")
		.withIndex("by_file_revision", (q: any) => q.eq("fileId", fileId))
		.collect();
	return rows.sort((left: any, right: any) => left.revision - right.revision);
}

async function getSnapshotRows(ctx: any, fileId: string): Promise<any[]> {
	const rows = await ctx.db
		.query("fileSnapshots")
		.withIndex("by_file_revision", (q: any) => q.eq("fileId", fileId))
		.collect();
	return rows.sort((left: any, right: any) => left.revision - right.revision);
}

async function getSnapshotAtOrBefore(ctx: any, fileId: string, revision: number): Promise<any | null> {
	const rows = await getSnapshotRows(ctx, fileId);
	let match: any | null = null;
	for (const row of rows) {
		if (row.revision <= revision) {
			match = row;
		}
	}
	return match;
}

async function ensureSyncHead(ctx: any): Promise<any> {
	const existing = await getSyncHead(ctx);
	if (existing) {
		return existing;
	}
	const id = await ctx.db.insert("syncHead", {
		singletonKey: SYNC_HEAD_SINGLETON_KEY,
		cursor: 0,
		updatedAtMs: Date.now(),
	});
	return await ctx.db.get(id);
}

async function getSyncHead(ctx: any): Promise<any | null> {
	const existing = await ctx.db
		.query("syncHead")
		.withIndex("by_singletonKey", (q: any) => q.eq("singletonKey", SYNC_HEAD_SINGLETON_KEY))
		.unique();
	return existing ?? null;
}

async function nextCursor(ctx: any): Promise<number> {
	const head = await ensureSyncHead(ctx);
	const cursor = head.cursor + 1;
	await ctx.db.patch(head._id, {
		cursor,
		updatedAtMs: Date.now(),
	});
	return cursor;
}

async function createConflict(
	ctx: any,
	args: {
		fileId: string;
		type: "text" | "binary" | "rename" | "delete" | "stale_base";
		baseRevision: number;
		headRevision: number;
		path: string;
		serverPath: string;
		clientId: string;
		attemptedStorageId?: any;
		attemptedContentHash?: string;
		attemptedSizeBytes?: number;
		attemptedContentKind?: "text" | "binary";
	}): Promise<string> {
	return await ctx.db.insert("conflicts", {
		fileId: args.fileId,
		status: "open",
		type: args.type,
		baseRevision: args.baseRevision,
		headRevision: args.headRevision,
		path: args.path,
		serverPath: args.serverPath,
		clientId: args.clientId,
		attemptedStorageId: args.attemptedStorageId,
		attemptedContentHash: args.attemptedContentHash,
		attemptedSizeBytes: args.attemptedSizeBytes,
		attemptedContentKind: args.attemptedContentKind,
		createdAtMs: Date.now(),
	});
}

async function deleteIfPresent(ctx: any, storageId: any | undefined): Promise<void> {
	if (storageId) {
		await ctx.storage.delete(storageId);
	}
}

async function readStorageText(ctx: any, storageId: any | undefined): Promise<string | null> {
	if (!storageId) {
		return null;
	}
	const blob = await ctx.storage.get(storageId);
	if (!blob) {
		return null;
	}
	return new TextDecoder().decode(await blob.arrayBuffer());
}

async function storeText(ctx: any, text: string): Promise<any> {
	return await ctx.storage.store(new Blob([new TextEncoder().encode(text)], { type: "text/plain" }));
}

async function getRevisionStorageAt(ctx: any, fileId: string, revision: number): Promise<any | undefined> {
	const snapshots = await getSnapshotRows(ctx, fileId);
	for (const snapshot of snapshots) {
		if (snapshot.revision === revision) {
			return snapshot.storageId;
		}
	}
	const revisions = await getRevisionRows(ctx, fileId);
	for (const row of revisions) {
		if (row.revision === revision && row.storageId) {
			return row.storageId;
		}
	}
	return undefined;
}

async function recordCommittedRevision(
	ctx: any,
	args: {
		fileId: string;
		revision: number;
		kind: "upsert" | "rename" | "delete";
		path: string;
		previousPath?: string;
		baseRevision: number;
		storageId?: any;
		contentHash?: string;
		sizeBytes?: number;
		contentKind?: "text" | "binary";
		clientId: string;
		idempotencyKey: string;
		updatedAtMs: number;
	}): Promise<number> {
	const cursor = await nextCursor(ctx);
	await ctx.db.insert("fileRevisions", {
		fileId: args.fileId,
		revision: args.revision,
		globalCursor: cursor,
		kind: args.kind,
		path: args.path,
		previousPath: args.previousPath,
		baseRevision: args.baseRevision,
		storageId: args.storageId,
		contentHash: args.contentHash,
		sizeBytes: args.sizeBytes,
		contentKind: args.contentKind,
		clientId: args.clientId,
		idempotencyKey: args.idempotencyKey,
		createdAtMs: args.updatedAtMs,
	});
	await ctx.db.insert("globalChanges", {
		cursor,
		fileId: args.fileId,
		revision: args.revision,
		kind: args.kind,
		path: args.path,
		previousPath: args.previousPath,
		contentHash: args.contentHash,
		sizeBytes: args.sizeBytes,
		contentKind: args.contentKind,
		clientId: args.clientId,
		createdAtMs: args.updatedAtMs,
	});
	return cursor;
}

async function maybeCompactFileHistory(ctx: any, manifest: any): Promise<void> {
	if (manifest.deleted || !manifest.storageId || !manifest.contentHash || !manifest.contentKind) {
		return;
	}
	const revisions = await getRevisionRows(ctx, manifest.fileId);
	const latestSnapshotRevision = manifest.latestSnapshotRevision ?? 0;
	const revisionsSinceSnapshot = revisions.filter((row) => row.revision > latestSnapshotRevision);
	const bytesSinceSnapshot = revisionsSinceSnapshot.reduce(
		(total, row) => total + (row.sizeBytes ?? 0),
		0,
	);
	const latestSnapshot = latestSnapshotRevision
		? await getSnapshotAtOrBefore(ctx, manifest.fileId, latestSnapshotRevision)
		: null;
	const shouldCompact = shouldCompactFileHistory({
		opsSinceSnapshot: revisionsSinceSnapshot.length,
		bytesSinceSnapshot,
		lastCompactedAtMs: latestSnapshot?.createdAtMs ?? null,
		now: Date.now(),
		hasRecentChurn: revisionsSinceSnapshot.length > 0,
	});
	if (!shouldCompact || manifest.latestSnapshotRevision === manifest.revision) {
		return;
	}

	await ctx.db.insert("fileSnapshots", {
		fileId: manifest.fileId,
		revision: manifest.revision,
		path: manifest.path,
		storageId: manifest.storageId,
		contentHash: manifest.contentHash,
		sizeBytes: manifest.sizeBytes ?? 0,
		contentKind: manifest.contentKind,
		createdAtMs: Date.now(),
	});
	await ctx.db.patch(manifest._id, {
		latestSnapshotRevision: manifest.revision,
	});

	const activeClients = await ctx.db.query("clientPresence").collect();
	const now = Date.now();
	const activeCursors = activeClients
		.filter((row: any) => now - row.lastHeartbeatAt <= ACTIVE_CLIENT_WINDOW_MS)
		.map((row: any) => row.lastSeenCursor)
		.filter((cursor: number | undefined): cursor is number => typeof cursor === "number");
	const oldestActiveCursor =
		activeCursors.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...activeCursors);

	for (const row of revisions) {
		if (row.revision >= manifest.revision) {
			continue;
		}
		if (row.revision >= manifest.latestSnapshotRevision) {
			continue;
		}
		const olderThanActiveWatermark = row.globalCursor < oldestActiveCursor;
		const olderThanHardFloor = now - row.createdAtMs >= FILE_WAL_RETENTION_MAX_MS;
		if (!olderThanActiveWatermark && !olderThanHardFloor) {
			continue;
		}
		await ctx.db.delete(row._id);
	}

	const snapshots = await getSnapshotRows(ctx, manifest.fileId);
	for (const row of snapshots) {
		if (row.revision >= manifest.revision) {
			continue;
		}
		if (now - row.createdAtMs < FILE_WAL_RETENTION_MAX_MS) {
			continue;
		}
		await ctx.db.delete(row._id);
	}
}

async function resolveIdempotentCommit(ctx: any, idempotencyKey: string): Promise<any | null> {
	const existing = await ctx.db
		.query("fileRevisions")
		.withIndex("by_idempotencyKey", (q: any) => q.eq("idempotencyKey", idempotencyKey))
		.unique();
	if (!existing) {
		return null;
	}
	const manifest = await getManifestByFileId(ctx, existing.fileId);
	if (!manifest) {
		return null;
	}
	return {
		status: "committed" as const,
		fileId: manifest.fileId,
		revision: existing.revision,
		cursor: existing.globalCursor,
		path: existing.path,
		manifest: serializeManifest(manifest),
	};
}

export const issueUploadUrl = mutation({
	args: {
		convexSecret: v.string(),
		path: v.optional(v.string()),
		fileId: v.optional(v.string()),
		contentHash: v.string(),
		updatedAtMs: v.number(),
		sizeBytes: v.number(),
		clientId: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const existing = args.fileId
			? await getManifestByFileId(ctx, args.fileId)
			: args.path
				? await getManifestByPath(ctx, normalizePath(args.path))
				: null;
		const uploadUrl = await ctx.storage.generateUploadUrl();
		return {
			uploadUrl,
			existing: existing ? serializeManifest(existing) : null,
		};
	},
});

export const commitFileChange = mutation({
	args: {
		convexSecret: v.string(),
		fileId: v.optional(v.string()),
		path: v.string(),
		baseRevision: v.number(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		contentKind: contentKindValidator,
		sizeBytes: v.number(),
		clientId: v.string(),
		idempotencyKey: v.string(),
		updatedAtMs: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const existingCommit = await resolveIdempotentCommit(ctx, args.idempotencyKey);
		if (existingCommit) {
			return existingCommit;
		}

		const normalizedPath = normalizePath(args.path);
		let manifest = args.fileId ? await getManifestByFileId(ctx, args.fileId) : null;
		if (!manifest) {
			manifest = await getManifestByPath(ctx, normalizedPath);
		}
		const committedAt = clampCommittedAt(args.updatedAtMs);

		if (!manifest) {
			const fileId = args.fileId ?? crypto.randomUUID();
			const manifestId = await ctx.db.insert("fileManifests", {
				fileId,
				path: normalizedPath,
				revision: 1,
				deleted: false,
				storageId: args.storageId,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				contentKind: args.contentKind,
				latestSnapshotRevision: 1,
				updatedAtMs: committedAt,
				updatedByClientId: args.clientId,
			});
			await ctx.db.insert("fileSnapshots", {
				fileId,
				revision: 1,
				path: normalizedPath,
				storageId: args.storageId,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				contentKind: args.contentKind,
				createdAtMs: committedAt,
			});
			const cursor = await recordCommittedRevision(ctx, {
				fileId,
				revision: 1,
				kind: "upsert",
				path: normalizedPath,
				baseRevision: Math.max(0, args.baseRevision),
				storageId: args.storageId,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				contentKind: args.contentKind,
				clientId: args.clientId,
				idempotencyKey: args.idempotencyKey,
				updatedAtMs: committedAt,
			});
			const createdManifest = await ctx.db.get(manifestId);
			return {
				status: "committed" as const,
				fileId,
				revision: 1,
				cursor,
				path: normalizedPath,
				manifest: serializeManifest(createdManifest),
			};
		}

		const binaryDecision = decideBinaryCommit({
			headRevision: manifest.revision,
			baseRevision: args.baseRevision,
			deleted: manifest.deleted,
		});
		if (binaryDecision.kind === "conflict" && binaryDecision.conflictType === "delete") {
			const conflictId = await createConflict(ctx, {
				fileId: manifest.fileId,
				type: "delete",
				baseRevision: args.baseRevision,
				headRevision: manifest.revision,
				path: normalizedPath,
				serverPath: manifest.path,
				clientId: args.clientId,
				attemptedStorageId: args.storageId,
				attemptedContentHash: args.contentHash,
				attemptedSizeBytes: args.sizeBytes,
				attemptedContentKind: args.contentKind,
			});
			return {
				status: "conflict" as const,
				conflictId,
				fileId: manifest.fileId,
				headRevision: manifest.revision,
				path: manifest.path,
			};
		}

		if (binaryDecision.kind === "fast_forward") {
			const nextRevision = manifest.revision + 1;
			await ctx.db.patch(manifest._id, {
				path: normalizedPath,
				revision: nextRevision,
				deleted: false,
				storageId: args.storageId,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				contentKind: args.contentKind,
				updatedAtMs: committedAt,
				updatedByClientId: args.clientId,
			});
			const cursor = await recordCommittedRevision(ctx, {
				fileId: manifest.fileId,
				revision: nextRevision,
				kind: "upsert",
				path: normalizedPath,
				previousPath: manifest.path === normalizedPath ? undefined : manifest.path,
				baseRevision: args.baseRevision,
				storageId: args.storageId,
				contentHash: args.contentHash,
				sizeBytes: args.sizeBytes,
				contentKind: args.contentKind,
				clientId: args.clientId,
				idempotencyKey: args.idempotencyKey,
				updatedAtMs: committedAt,
			});
			const nextManifest = await getManifestByFileId(ctx, manifest.fileId);
			await maybeCompactFileHistory(ctx, nextManifest);
			return {
				status: "committed" as const,
				fileId: manifest.fileId,
				revision: nextRevision,
				cursor,
				path: normalizedPath,
				manifest: serializeManifest(nextManifest),
			};
		}

		if (args.contentKind === "binary" || manifest.contentKind !== "text") {
			const conflictId = await createConflict(ctx, {
				fileId: manifest.fileId,
				type: binaryDecision.conflictType,
				baseRevision: args.baseRevision,
				headRevision: manifest.revision,
				path: normalizedPath,
				serverPath: manifest.path,
				clientId: args.clientId,
				attemptedStorageId: args.storageId,
				attemptedContentHash: args.contentHash,
				attemptedSizeBytes: args.sizeBytes,
				attemptedContentKind: args.contentKind,
			});
			return {
				status: "conflict" as const,
				conflictId,
				fileId: manifest.fileId,
				headRevision: manifest.revision,
				path: manifest.path,
			};
		}

		const baseStorageId = await getRevisionStorageAt(ctx, manifest.fileId, args.baseRevision);
		if (!baseStorageId || !manifest.storageId) {
			const conflictId = await createConflict(ctx, {
				fileId: manifest.fileId,
				type: "stale_base",
				baseRevision: args.baseRevision,
				headRevision: manifest.revision,
				path: normalizedPath,
				serverPath: manifest.path,
				clientId: args.clientId,
				attemptedStorageId: args.storageId,
				attemptedContentHash: args.contentHash,
				attemptedSizeBytes: args.sizeBytes,
				attemptedContentKind: args.contentKind,
			});
			return {
				status: "conflict" as const,
				conflictId,
				fileId: manifest.fileId,
				headRevision: manifest.revision,
				path: manifest.path,
			};
		}

		const [baseText, currentText, incomingText] = await Promise.all([
			readStorageText(ctx, baseStorageId),
			readStorageText(ctx, manifest.storageId),
			readStorageText(ctx, args.storageId),
		]);
		if (baseText === null || currentText === null || incomingText === null) {
			const conflictId = await createConflict(ctx, {
				fileId: manifest.fileId,
				type: "stale_base",
				baseRevision: args.baseRevision,
				headRevision: manifest.revision,
				path: normalizedPath,
				serverPath: manifest.path,
				clientId: args.clientId,
				attemptedStorageId: args.storageId,
				attemptedContentHash: args.contentHash,
				attemptedSizeBytes: args.sizeBytes,
				attemptedContentKind: args.contentKind,
			});
			return {
				status: "conflict" as const,
				conflictId,
				fileId: manifest.fileId,
				headRevision: manifest.revision,
				path: manifest.path,
			};
		}

		const textDecision = decideTextCommit({
			headRevision: manifest.revision,
			baseRevision: args.baseRevision,
			deleted: manifest.deleted,
			baseText,
			currentText,
			incomingText,
		});
		if (textDecision.kind === "conflict") {
			const conflictId = await createConflict(ctx, {
				fileId: manifest.fileId,
				type: textDecision.conflictType,
				baseRevision: args.baseRevision,
				headRevision: manifest.revision,
				path: normalizedPath,
				serverPath: manifest.path,
				clientId: args.clientId,
				attemptedStorageId: args.storageId,
				attemptedContentHash: args.contentHash,
				attemptedSizeBytes: args.sizeBytes,
				attemptedContentKind: args.contentKind,
			});
			return {
				status: "conflict" as const,
				conflictId,
				fileId: manifest.fileId,
				headRevision: manifest.revision,
				path: manifest.path,
			};
		}
		if (textDecision.kind !== "merged") {
			throw new ConvexError("Unexpected fast-forward text merge state.");
		}

		const mergedStorageId = await storeText(ctx, textDecision.mergedText);
		const mergedBytes = new TextEncoder().encode(textDecision.mergedText);
		const mergedHashBuffer = await crypto.subtle.digest("SHA-256", mergedBytes);
		const mergedHash = Array.from(new Uint8Array(mergedHashBuffer))
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("");
		const nextRevision = manifest.revision + 1;
		await ctx.db.patch(manifest._id, {
			path: manifest.path,
			revision: nextRevision,
			deleted: false,
			storageId: mergedStorageId,
			contentHash: mergedHash,
			sizeBytes: mergedBytes.byteLength,
			contentKind: "text",
			updatedAtMs: committedAt,
			updatedByClientId: args.clientId,
		});
		const cursor = await recordCommittedRevision(ctx, {
			fileId: manifest.fileId,
			revision: nextRevision,
			kind: "upsert",
			path: manifest.path,
			baseRevision: args.baseRevision,
			storageId: mergedStorageId,
			contentHash: mergedHash,
			sizeBytes: mergedBytes.byteLength,
			contentKind: "text",
			clientId: args.clientId,
			idempotencyKey: args.idempotencyKey,
			updatedAtMs: committedAt,
		});
		const nextManifest = await getManifestByFileId(ctx, manifest.fileId);
		await maybeCompactFileHistory(ctx, nextManifest);
		return {
			status: "committed" as const,
			fileId: manifest.fileId,
			revision: nextRevision,
			cursor,
			path: manifest.path,
			manifest: serializeManifest(nextManifest),
			merged: true,
			mergedText: textDecision.mergedText,
		};
	},
});

export const commitRename = mutation({
	args: {
		convexSecret: v.string(),
		fileId: v.string(),
		newPath: v.string(),
		baseRevision: v.number(),
		clientId: v.string(),
		idempotencyKey: v.string(),
		updatedAtMs: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const existingCommit = await resolveIdempotentCommit(ctx, args.idempotencyKey);
		if (existingCommit) {
			return existingCommit;
		}
		const manifest = await getManifestByFileId(ctx, args.fileId);
		if (!manifest) {
			throw new ConvexError("File not found.");
		}
		const normalizedPath = normalizePath(args.newPath);
		const renameDecision = decideRenameCommit({
			headRevision: manifest.revision,
			baseRevision: args.baseRevision,
			deleted: manifest.deleted,
		});
		if (renameDecision.kind === "conflict") {
			const conflictId = await createConflict(ctx, {
				fileId: manifest.fileId,
				type: renameDecision.conflictType,
				baseRevision: args.baseRevision,
				headRevision: manifest.revision,
				path: normalizedPath,
				serverPath: manifest.path,
				clientId: args.clientId,
			});
			return {
				status: "conflict" as const,
				conflictId,
				fileId: manifest.fileId,
				headRevision: manifest.revision,
				path: manifest.path,
			};
		}
		const nextRevision = manifest.revision + 1;
		await ctx.db.patch(manifest._id, {
			path: normalizedPath,
			revision: nextRevision,
			updatedAtMs: clampCommittedAt(args.updatedAtMs),
			updatedByClientId: args.clientId,
		});
		const cursor = await recordCommittedRevision(ctx, {
			fileId: manifest.fileId,
			revision: nextRevision,
			kind: "rename",
			path: normalizedPath,
			previousPath: manifest.path,
			baseRevision: args.baseRevision,
			clientId: args.clientId,
			idempotencyKey: args.idempotencyKey,
			updatedAtMs: clampCommittedAt(args.updatedAtMs),
		});
		const nextManifest = await getManifestByFileId(ctx, manifest.fileId);
		return {
			status: "committed" as const,
			fileId: manifest.fileId,
			revision: nextRevision,
			cursor,
			path: normalizedPath,
			manifest: serializeManifest(nextManifest),
		};
	},
});

export const commitDelete = mutation({
	args: {
		convexSecret: v.string(),
		fileId: v.string(),
		baseRevision: v.number(),
		clientId: v.string(),
		idempotencyKey: v.string(),
		updatedAtMs: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const existingCommit = await resolveIdempotentCommit(ctx, args.idempotencyKey);
		if (existingCommit) {
			return existingCommit;
		}
		const manifest = await getManifestByFileId(ctx, args.fileId);
		if (!manifest) {
			throw new ConvexError("File not found.");
		}
		const deleteDecision = decideDeleteCommit({
			headRevision: manifest.revision,
			baseRevision: args.baseRevision,
			deleted: manifest.deleted,
		});
		if (deleteDecision.kind === "conflict") {
			const conflictId = await createConflict(ctx, {
				fileId: manifest.fileId,
				type: deleteDecision.conflictType,
				baseRevision: args.baseRevision,
				headRevision: manifest.revision,
				path: manifest.path,
				serverPath: manifest.path,
				clientId: args.clientId,
			});
			return {
				status: "conflict" as const,
				conflictId,
				fileId: manifest.fileId,
				headRevision: manifest.revision,
				path: manifest.path,
			};
		}
		const nextRevision = manifest.revision + 1;
		await ctx.db.patch(manifest._id, {
			revision: nextRevision,
			deleted: true,
			storageId: undefined,
			contentHash: undefined,
			sizeBytes: undefined,
			contentKind: undefined,
			updatedAtMs: clampCommittedAt(args.updatedAtMs),
			updatedByClientId: args.clientId,
		});
		const cursor = await recordCommittedRevision(ctx, {
			fileId: manifest.fileId,
			revision: nextRevision,
			kind: "delete",
			path: manifest.path,
			baseRevision: args.baseRevision,
			clientId: args.clientId,
			idempotencyKey: args.idempotencyKey,
			updatedAtMs: clampCommittedAt(args.updatedAtMs),
		});
		const nextManifest = await getManifestByFileId(ctx, manifest.fileId);
		return {
			status: "committed" as const,
			fileId: manifest.fileId,
			revision: nextRevision,
			cursor,
			path: manifest.path,
			manifest: serializeManifest(nextManifest),
		};
	},
});

/** Tiny reactive query so Convex clients can subscribe and wake when any vault commit advances the global cursor. */
export const watchSyncHead = query({
	args: {
		convexSecret: v.string(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const head = await getSyncHead(ctx);
		return {
			headCursor: head?.cursor ?? 0,
			updatedAtMs: head?.updatedAtMs ?? 0,
		};
	},
});

export const listChangesSince = query({
	args: {
		convexSecret: v.string(),
		cursor: v.number(),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const limit = Math.max(1, Math.min(2000, args.limit ?? 1000));
		const rows = await ctx.db
			.query("globalChanges")
			.withIndex("by_cursor", (q: any) => q.gt("cursor", args.cursor))
			.take(limit);
		const head = await getSyncHead(ctx);
		return {
			headCursor: head?.cursor ?? 0,
			changes: rows.map((row: any) => ({
				cursor: row.cursor,
				fileId: row.fileId,
				revision: row.revision,
				kind: row.kind,
				path: row.path,
				previousPath: row.previousPath ?? null,
				contentHash: row.contentHash ?? null,
				sizeBytes: row.sizeBytes ?? null,
				contentKind: row.contentKind ?? null,
				clientId: row.clientId,
				createdAtMs: row.createdAtMs,
			})),
		};
	},
});

export const getFileSnapshotOrOps = query({
	args: {
		convexSecret: v.string(),
		fileId: v.string(),
		fromRevision: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const manifest = await getManifestByFileId(ctx, args.fileId);
		if (!manifest) {
			return null;
		}
		const snapshots = await getSnapshotRows(ctx, args.fileId);
		const latestSnapshot = snapshots.at(-1) ?? null;
		const revisions = await getRevisionRows(ctx, args.fileId);
		const ops = [] as any[];
		for (const row of revisions) {
			if (row.revision <= args.fromRevision) {
				continue;
			}
			ops.push({
				revision: row.revision,
				kind: row.kind,
				path: row.path,
				previousPath: row.previousPath ?? null,
				contentHash: row.contentHash ?? null,
				sizeBytes: row.sizeBytes ?? null,
				contentKind: row.contentKind ?? null,
				url: row.storageId ? await ctx.storage.getUrl(row.storageId) : null,
				createdAtMs: row.createdAtMs,
			});
		}
		if (!manifest.deleted && latestSnapshot && args.fromRevision < latestSnapshot.revision) {
			return {
				mode: "snapshot" as const,
				manifest: serializeManifest(manifest),
				snapshot: {
					revision: latestSnapshot.revision,
					path: latestSnapshot.path,
					contentHash: latestSnapshot.contentHash,
					sizeBytes: latestSnapshot.sizeBytes,
					contentKind: latestSnapshot.contentKind,
					url: await ctx.storage.getUrl(latestSnapshot.storageId),
				},
				ops,
			};
		}
		return {
			mode: "ops" as const,
			manifest: serializeManifest(manifest),
			snapshot: latestSnapshot
				? {
					revision: latestSnapshot.revision,
					path: latestSnapshot.path,
					contentHash: latestSnapshot.contentHash,
					sizeBytes: latestSnapshot.sizeBytes,
					contentKind: latestSnapshot.contentKind,
					url: await ctx.storage.getUrl(latestSnapshot.storageId),
				}
				: null,
			ops,
		};
	},
});

export const reportClientCursor = mutation({
	args: {
		convexSecret: v.string(),
		clientId: v.string(),
		cursor: v.number(),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const existing = await ctx.db
			.query("clientPresence")
			.withIndex("by_clientId", (q: any) => q.eq("clientId", args.clientId))
			.unique();
		if (!existing) {
			return;
		}
		await ctx.db.patch(existing._id, {
			lastSeenCursor: args.cursor,
			lastCursorSeenAt: Date.now(),
		});
	},
});

export const backfillLegacyVaultFiles = mutation({
	args: {
		convexSecret: v.string(),
		cursorPath: v.optional(v.string()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const limit = Math.max(1, Math.min(500, args.limit ?? 250));
		const rows = args.cursorPath
			? await ctx.db
					.query("vaultFiles")
					.withIndex("by_path", (q: any) => q.gt("path", args.cursorPath))
					.take(limit)
			: await ctx.db.query("vaultFiles").withIndex("by_path").take(limit);
		let processed = 0;
		for (const row of rows) {
			const existing = await getManifestByPath(ctx, row.path);
			if (existing) {
				processed += 1;
				continue;
			}
			const fileId = crypto.randomUUID();
			await ctx.db.insert("fileManifests", {
				fileId,
				path: row.path,
				revision: 1,
				deleted: false,
				storageId: row.storageId,
				contentHash: row.contentHash,
				sizeBytes: row.sizeBytes,
				contentKind: row.contentKind,
				latestSnapshotRevision: 1,
				updatedAtMs: row.updatedAtMs,
				updatedByClientId: row.updatedByClientId,
			});
			await ctx.db.insert("fileSnapshots", {
				fileId,
				revision: 1,
				path: row.path,
				storageId: row.storageId,
				contentHash: row.contentHash,
				sizeBytes: row.sizeBytes,
				contentKind: row.contentKind,
				createdAtMs: row.updatedAtMs,
			});
			await recordCommittedRevision(ctx, {
				fileId,
				revision: 1,
				kind: "upsert",
				path: row.path,
				baseRevision: 0,
				storageId: row.storageId,
				contentHash: row.contentHash,
				sizeBytes: row.sizeBytes,
				contentKind: row.contentKind,
				clientId: row.updatedByClientId,
				idempotencyKey: `legacy:${fileId}:1`,
				updatedAtMs: row.updatedAtMs,
			});
			processed += 1;
		}
		return {
			processed,
			done: rows.length < limit,
			nextCursorPath: rows.length === 0 ? null : rows.at(-1)?.path ?? null,
			thresholds: {
				opThreshold: FILE_WAL_COMPACTION_OP_THRESHOLD,
				bytesThreshold: FILE_WAL_COMPACTION_BYTES_THRESHOLD,
				staleMs: FILE_WAL_COMPACTION_STALE_MS,
			},
		};
	},
});

export const cleanupExpiredTrash = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const rows = await ctx.db.query("vaultFileTrash").collect();
		for (const row of rows) {
			if (row.expiresAtMs > now) {
				continue;
			}
			await ctx.storage.delete(row.storageId);
			await ctx.db.delete(row._id);
		}
	},
});

export const listOpenConflicts = query({
	args: { convexSecret: v.string() },
	handler: async (ctx, args) => {
		await requirePluginSecret(ctx, args.convexSecret);
		const rows = await ctx.db
			.query("conflicts")
			.withIndex("by_status", (q: any) => q.eq("status", "open"))
			.collect();
		return rows
			.sort((left, right) => left.createdAtMs - right.createdAtMs)
			.map((row) => ({
				id: row._id,
				fileId: row.fileId,
				type: row.type,
				baseRevision: row.baseRevision,
				headRevision: row.headRevision,
				path: row.path,
				serverPath: row.serverPath,
				clientId: row.clientId,
				createdAtMs: row.createdAtMs,
			}));
	},
});
