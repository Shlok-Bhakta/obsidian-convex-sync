import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { editorCursor } from "./_lib/validators";

export default defineSchema({
	tasks: defineTable({
		text: v.string(),
		isCompleted: v.boolean(),
	}),
	vaultFiles: defineTable({
		path: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		sizeBytes: v.number(),
		updatedAtMs: v.number(),
		updatedByClientId: v.string(),
	})
		.index("by_path", ["path"])
		.index("by_updatedAtMs", ["updatedAtMs"]),
	vaultFolders: defineTable({
		path: v.string(),
		updatedAtMs: v.number(),
		isExplicitlyEmpty: v.boolean(),
		updatedByClientId: v.optional(v.string()),
	})
		.index("by_path", ["path"])
		.index("by_updatedAtMs", ["updatedAtMs"]),
	vaultBundles: defineTable({
		scope: v.string(),
		storageId: v.id("_storage"),
		contentHash: v.string(),
		sizeBytes: v.number(),
		updatedAtMs: v.number(),
		updatedByClientId: v.string(),
	}).index("by_scope", ["scope"]),
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
	}).index("by_clientId", ["clientId"]),
});
