import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const editorPosition = v.object({
	line: v.number(),
	ch: v.number(),
});

const editorCursor = v.object({
	anchor: editorPosition,
	head: editorPosition,
	from: editorPosition,
	to: editorPosition,
});

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
