import type { ConvexHttpClient } from "convex/browser";
import type { MyPluginSettings } from "../settings";

export type FileSyncHost = {
	app: import("obsidian").App;
	settings: MyPluginSettings;
	getConvexHttpClient(): ConvexHttpClient;
	getPresenceSessionId(): string;
	reportSyncProgress?: (status: {
		phase: string;
		completed: number;
		total: number;
	}) => void;
};

export type Snapshot = {
	files: Array<{
		path: string;
		contentHash: string;
		sizeBytes: number;
		updatedAtMs: number;
		updatedByClientId: string;
	}>;
	folders: Array<{
		path: string;
		updatedAtMs: number;
		isExplicitlyEmpty: boolean;
		updatedByClientId: string;
	}>;
};

export type LocalFileEntry = {
	path: string;
	updatedAtMs: number;
	readBytes: () => Promise<ArrayBuffer>;
	writeBytes: (bytes: ArrayBuffer) => Promise<void>;
	createBytes: (bytes: ArrayBuffer) => Promise<void>;
};

export type LocalEntriesState = {
	files: LocalFileEntry[];
	folders: string[];
	emptyFolders: string[];
};
