import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { editorCursor } from "./_lib/validators";

export default defineSchema({
	tasks: defineTable({
		text: v.string(),
		isCompleted: v.boolean(),
	}),
	fileManifests: defineTable({
		fileId: v.string(),
		path: v.string(),
		revision: v.number(),
		deleted: v.boolean(),
		storageId: v.optional(v.id("_storage")),
		contentHash: v.optional(v.string()),
		sizeBytes: v.optional(v.number()),
		contentKind: v.optional(v.union(v.literal("text"), v.literal("binary"))),
		latestSnapshotRevision: v.optional(v.number()),
		updatedAtMs: v.number(),
		updatedByClientId: v.string(),
	})
		.index("by_fileId", ["fileId"])
		.index("by_path", ["path"]),
	fileRevisions: defineTable({
		fileId: v.string(),
		revision: v.number(),
		globalCursor: v.number(),
		kind: v.union(v.literal("upsert"), v.literal("rename"), v.literal("delete")),
		path: v.string(),
		previousPath: v.optional(v.string()),
		baseRevision: v.number(),
		storageId: v.optional(v.id("_storage")),
		contentHash: v.optional(v.string()),
		sizeBytes: v.optional(v.number()),
		contentKind: v.optional(v.union(v.literal("text"), v.literal("binary"))),
		clientId: v.string(),
		idempotencyKey: v.string(),
		createdAtMs: v.number(),
	})
		.index("by_file_revision", ["fileId", "revision"])
		.index("by_idempotencyKey", ["idempotencyKey"]),
	fileSnapshots: defineTable({
		fileId: v.string(),
		revision: v.number(),
		path: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		sizeBytes: v.number(),
		contentKind: v.union(v.literal("text"), v.literal("binary")),
		createdAtMs: v.number(),
	})
		.index("by_file_revision", ["fileId", "revision"]),
	globalChanges: defineTable({
		cursor: v.number(),
		fileId: v.string(),
		revision: v.number(),
		kind: v.union(v.literal("upsert"), v.literal("rename"), v.literal("delete")),
		path: v.string(),
		previousPath: v.optional(v.string()),
		contentHash: v.optional(v.string()),
		sizeBytes: v.optional(v.number()),
		contentKind: v.optional(v.union(v.literal("text"), v.literal("binary"))),
		clientId: v.string(),
		createdAtMs: v.number(),
	})
		.index("by_cursor", ["cursor"])
		.index("by_fileId", ["fileId"]),
	conflicts: defineTable({
		fileId: v.string(),
		status: v.union(v.literal("open"), v.literal("resolved")),
		type: v.union(
			v.literal("text"),
			v.literal("binary"),
			v.literal("rename"),
			v.literal("delete"),
			v.literal("stale_base"),
		),
		baseRevision: v.number(),
		headRevision: v.number(),
		path: v.string(),
		serverPath: v.string(),
		clientId: v.string(),
		attemptedStorageId: v.optional(v.id("_storage")),
		attemptedContentHash: v.optional(v.string()),
		attemptedSizeBytes: v.optional(v.number()),
		attemptedContentKind: v.optional(v.union(v.literal("text"), v.literal("binary"))),
		createdAtMs: v.number(),
	})
		.index("by_status", ["status"])
		.index("by_fileId", ["fileId"]),
	syncHead: defineTable({
		singletonKey: v.string(),
		cursor: v.number(),
		updatedAtMs: v.number(),
	}).index("by_singletonKey", ["singletonKey"]),
	vaultFiles: defineTable({
		path: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		sizeBytes: v.number(),
		contentKind: v.union(v.literal("text"), v.literal("binary")),
		updatedAtMs: v.number(),
		updatedByClientId: v.string(),
	})
		.index("by_path", ["path"])
		.index("by_updatedAtMs", ["updatedAtMs"]),
	vaultFileTrash: defineTable({
		path: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		sizeBytes: v.number(),
		contentKind: v.union(v.literal("text"), v.literal("binary")),
		lastKnownUpdatedAtMs: v.number(),
		deletedAtMs: v.number(),
		deletedByClientId: v.string(),
		expiresAtMs: v.number(),
	})
		.index("by_path", ["path"])
		.index("by_expiresAtMs", ["expiresAtMs"]),
	vaultBinaryVersions: defineTable({
		path: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		sizeBytes: v.number(),
		createdAtMs: v.number(),
	})
		.index("by_path", ["path"])
		.index("by_createdAtMs", ["createdAtMs"]),
	vaultFolders: defineTable({
		path: v.string(),
		updatedAtMs: v.number(),
		isExplicitlyEmpty: v.boolean(),
		updatedByClientId: v.optional(v.string()),
	})
		.index("by_path", ["path"])
		.index("by_updatedAtMs", ["updatedAtMs"]),
	vaultOperations: defineTable({
		clientId: v.string(),
		kind: v.union(
			v.literal("file_upsert"),
			v.literal("file_delete"),
			v.literal("path_rename"),
		),
		entryType: v.union(
			v.literal("file"),
			v.literal("folder"),
		),
		path: v.string(),
		oldPath: v.optional(v.string()),
		contentHash: v.optional(v.string()),
		contentKind: v.optional(v.union(v.literal("text"), v.literal("binary"))),
		sizeBytes: v.optional(v.number()),
		updatedAtMs: v.number(),
	})
		.index("by_updatedAtMs", ["updatedAtMs"])
		.index("by_path", ["path"]),
	vaultBootstraps: defineTable({
		status: v.union(
			v.literal("building"),
			v.literal("ready"),
			v.literal("expired"),
			v.literal("failed"),
		),
		phase: v.string(),
		filesProcessed: v.number(),
		filesTotal: v.number(),
		bytesProcessed: v.number(),
		bytesTotal: v.number(),
		storageId: v.optional(v.id("_storage")),
		sizeBytes: v.optional(v.number()),
		contentHash: v.optional(v.string()),
		startedAtMs: v.number(),
		readyAtMs: v.optional(v.number()),
		expiresAtMs: v.optional(v.number()),
		downloadToken: v.optional(v.string()),
		archiveName: v.optional(v.string()),
		createdByClientId: v.string(),
		errorMessage: v.optional(v.string()),
	}),
	/** At most one row: shared vault API key for this deployment. */
	pluginAuth: defineTable({
		secret: v.string(),
	}),
	/**
	 * Per Obsidian app instance: heartbeats + editor presence for live client list.
	 * Rows older than ~30s without a heartbeat are treated as offline (filtered in queries; GC removes them).
	 */
	clientPresence: defineTable({
		clientId: v.string(),
		openFilePath: v.string(),
		cursor: editorCursor,
		lastHeartbeatAt: v.number(),
		lastSeenCursor: v.optional(v.number()),
		lastCursorSeenAt: v.optional(v.number()),
	}).index("by_clientId", ["clientId"]),
});
