import type { ContentKind } from "./binary";

export type SyncFileMetadata = {
	fileId: string;
	path: string;
	revision: number;
	deleted: boolean;
	updatedAtMs: number;
	contentHash: string | null;
	contentKind: ContentKind | null;
};

export type SyncOutboxEntry = {
	opId: string;
	kind: "upsert" | "rename" | "delete";
	path: string;
	newPath?: string;
	fileId?: string;
	textContent?: string;
	updatedAtMs: number;
	queuedAtMs: number;
};

export interface SyncStateStore {
	getLastSeenCursor(): Promise<number>;
	setLastSeenCursor(cursor: number): Promise<void>;
	getMetadataByPath(path: string): Promise<SyncFileMetadata | null>;
	getMetadataByFileId(fileId: string): Promise<SyncFileMetadata | null>;
	listMetadata(): Promise<SyncFileMetadata[]>;
	putMetadata(metadata: SyncFileMetadata): Promise<void>;
	queueUpsert(entry: Omit<SyncOutboxEntry, "opId" | "kind" | "queuedAtMs">): Promise<void>;
	queueRename(entry: Omit<SyncOutboxEntry, "opId" | "kind" | "queuedAtMs"> & { newPath: string }): Promise<void>;
	queueDelete(entry: Omit<SyncOutboxEntry, "opId" | "kind" | "queuedAtMs">): Promise<void>;
	listOutbox(): Promise<SyncOutboxEntry[]>;
	deleteOutbox(opId: string): Promise<void>;
	clear(): Promise<void>;
}

const DB_NAME = "obsidian-convex-sync";
const DB_VERSION = 2;
const STATE_STORE = "state";
const METADATA_STORE = "metadata";
const OUTBOX_STORE = "outbox";
const FILE_ID_INDEX = "by_fileId";

function normalizePathKey(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

class IndexedDbBackedSyncStateStore implements SyncStateStore {
	private readonly dbPromise: Promise<IDBDatabase>;

	constructor() {
		this.dbPromise = this.openWithRecovery();
	}

	private openDatabase(version: number): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const request = indexedDB.open(DB_NAME, version);
			request.onerror = () => reject(request.error);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STATE_STORE)) {
					db.createObjectStore(STATE_STORE, { keyPath: "key" });
				}
				if (!db.objectStoreNames.contains(METADATA_STORE)) {
					const store = db.createObjectStore(METADATA_STORE, { keyPath: "path" });
					store.createIndex(FILE_ID_INDEX, "fileId", { unique: true });
				}
				if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
					db.createObjectStore(OUTBOX_STORE, { keyPath: "opId" });
				}
			};
			request.onsuccess = () => resolve(request.result);
		});
	}

	private async recreateDatabase(): Promise<IDBDatabase> {
		await new Promise<void>((resolve, reject) => {
			const deleteRequest = indexedDB.deleteDatabase(DB_NAME);
			deleteRequest.onerror = () => reject(deleteRequest.error);
			deleteRequest.onblocked = () => reject(new Error("IndexedDB reset was blocked."));
			deleteRequest.onsuccess = () => resolve();
		});
		return await this.openDatabase(DB_VERSION);
	}

	private async openWithRecovery(): Promise<IDBDatabase> {
		const db = await this.openDatabase(DB_VERSION);
		if (
			db.objectStoreNames.contains(STATE_STORE) &&
			db.objectStoreNames.contains(METADATA_STORE) &&
			db.objectStoreNames.contains(OUTBOX_STORE)
		) {
			return db;
		}
		db.close();
		return await this.recreateDatabase();
	}

	private async transaction<T>(
		storeNames: string[],
		mode: IDBTransactionMode,
		work: (tx: IDBTransaction) => Promise<T>,
	): Promise<T> {
		const db = await this.dbPromise;
		const tx = db.transaction(storeNames, mode);
		const result = await work(tx);
		await new Promise<void>((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
		return result;
	}

	private async getRecord<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
		return await this.transaction([storeName], "readonly", async (tx) => {
			const store = tx.objectStore(storeName);
			const request = store.get(key);
			return await new Promise<T | null>((resolve, reject) => {
				request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
				request.onerror = () => reject(request.error);
			});
		});
	}

	private async getAll<T>(storeName: string): Promise<T[]> {
		return await this.transaction([storeName], "readonly", async (tx) => {
			const request = tx.objectStore(storeName).getAll();
			return await new Promise<T[]>((resolve, reject) => {
				request.onsuccess = () => resolve((request.result as T[]) ?? []);
				request.onerror = () => reject(request.error);
			});
		});
	}

	async getLastSeenCursor(): Promise<number> {
		const row = await this.getRecord<{ key: string; value: number }>(STATE_STORE, "lastSeenCursor");
		return row?.value ?? 0;
	}

	async setLastSeenCursor(cursor: number): Promise<void> {
		await this.transaction([STATE_STORE], "readwrite", async (tx) => {
			tx.objectStore(STATE_STORE).put({ key: "lastSeenCursor", value: cursor });
		});
	}

	async getMetadataByPath(path: string): Promise<SyncFileMetadata | null> {
		return await this.getRecord<SyncFileMetadata>(METADATA_STORE, normalizePathKey(path));
	}

	async getMetadataByFileId(fileId: string): Promise<SyncFileMetadata | null> {
		return await this.transaction([METADATA_STORE], "readonly", async (tx) => {
			const request = tx.objectStore(METADATA_STORE).index(FILE_ID_INDEX).get(fileId);
			return await new Promise<SyncFileMetadata | null>((resolve, reject) => {
				request.onsuccess = () =>
					resolve((request.result as SyncFileMetadata | undefined) ?? null);
				request.onerror = () => reject(request.error);
			});
		});
	}

	async listMetadata(): Promise<SyncFileMetadata[]> {
		return await this.getAll<SyncFileMetadata>(METADATA_STORE);
	}

	async putMetadata(metadata: SyncFileMetadata): Promise<void> {
		const normalized = { ...metadata, path: normalizePathKey(metadata.path) };
		await this.transaction([METADATA_STORE], "readwrite", async (tx) => {
			const store = tx.objectStore(METADATA_STORE);
			const index = store.index(FILE_ID_INDEX);
			const existingRequest = index.get(normalized.fileId);
			const existing = await new Promise<SyncFileMetadata | null>((resolve, reject) => {
				existingRequest.onsuccess = () =>
					resolve((existingRequest.result as SyncFileMetadata | undefined) ?? null);
				existingRequest.onerror = () => reject(existingRequest.error);
			});
			if (existing && existing.path !== normalized.path) {
				store.delete(existing.path);
			}
			store.put(normalized);
		});
	}

	private async putOutbox(entry: SyncOutboxEntry): Promise<void> {
		await this.transaction([OUTBOX_STORE], "readwrite", async (tx) => {
			tx.objectStore(OUTBOX_STORE).put(entry);
		});
	}

	async queueUpsert(
		entry: Omit<SyncOutboxEntry, "opId" | "kind" | "queuedAtMs">,
	): Promise<void> {
		const path = normalizePathKey(entry.path);
		const opId = `upsert:${entry.fileId ?? path}`;
		await this.transaction([OUTBOX_STORE], "readwrite", async (tx) => {
			const store = tx.objectStore(OUTBOX_STORE);
			const request = store.get(opId);
			const existing = await new Promise<SyncOutboxEntry | null>((resolve, reject) => {
				request.onsuccess = () => resolve((request.result as SyncOutboxEntry | undefined) ?? null);
				request.onerror = () => reject(request.error);
			});
			store.put({
				...entry,
				opId,
				kind: "upsert",
				path,
				textContent: entry.textContent ?? existing?.textContent,
				queuedAtMs: Date.now(),
			});
		});
	}

	async queueRename(
		entry: Omit<SyncOutboxEntry, "opId" | "kind" | "queuedAtMs"> & { newPath: string },
	): Promise<void> {
		const path = normalizePathKey(entry.path);
		await this.putOutbox({
			...entry,
			opId: `rename:${entry.fileId ?? path}`,
			kind: "rename",
			path,
			newPath: normalizePathKey(entry.newPath),
			queuedAtMs: Date.now(),
		});
	}

	async queueDelete(
		entry: Omit<SyncOutboxEntry, "opId" | "kind" | "queuedAtMs">,
	): Promise<void> {
		const path = normalizePathKey(entry.path);
		await this.putOutbox({
			...entry,
			opId: `delete:${entry.fileId ?? path}`,
			kind: "delete",
			path,
			queuedAtMs: Date.now(),
		});
	}

	async listOutbox(): Promise<SyncOutboxEntry[]> {
		const rows = await this.getAll<SyncOutboxEntry>(OUTBOX_STORE);
		return rows.sort((left, right) => left.queuedAtMs - right.queuedAtMs);
	}

	async deleteOutbox(opId: string): Promise<void> {
		await this.transaction([OUTBOX_STORE], "readwrite", async (tx) => {
			tx.objectStore(OUTBOX_STORE).delete(opId);
		});
	}

	async clear(): Promise<void> {
		await this.transaction([STATE_STORE, METADATA_STORE, OUTBOX_STORE], "readwrite", async (tx) => {
			tx.objectStore(STATE_STORE).clear();
			tx.objectStore(METADATA_STORE).clear();
			tx.objectStore(OUTBOX_STORE).clear();
		});
	}
}

export class InMemorySyncStateStore implements SyncStateStore {
	private lastSeenCursor = 0;
	private readonly metadataByPath = new Map<string, SyncFileMetadata>();
	private readonly metadataByFileId = new Map<string, SyncFileMetadata>();
	private readonly outbox = new Map<string, SyncOutboxEntry>();

	async getLastSeenCursor(): Promise<number> {
		return this.lastSeenCursor;
	}

	async setLastSeenCursor(cursor: number): Promise<void> {
		this.lastSeenCursor = cursor;
	}

	async getMetadataByPath(path: string): Promise<SyncFileMetadata | null> {
		return this.metadataByPath.get(normalizePathKey(path)) ?? null;
	}

	async getMetadataByFileId(fileId: string): Promise<SyncFileMetadata | null> {
		return this.metadataByFileId.get(fileId) ?? null;
	}

	async listMetadata(): Promise<SyncFileMetadata[]> {
		return [...this.metadataByPath.values()];
	}

	async putMetadata(metadata: SyncFileMetadata): Promise<void> {
		const normalized = { ...metadata, path: normalizePathKey(metadata.path) };
		const existing = this.metadataByFileId.get(normalized.fileId);
		if (existing && existing.path !== normalized.path) {
			this.metadataByPath.delete(existing.path);
		}
		this.metadataByPath.set(normalized.path, normalized);
		this.metadataByFileId.set(normalized.fileId, normalized);
	}

	async queueUpsert(
		entry: Omit<SyncOutboxEntry, "opId" | "kind" | "queuedAtMs">,
	): Promise<void> {
		const path = normalizePathKey(entry.path);
		const opId = `upsert:${entry.fileId ?? path}`;
		const existing = this.outbox.get(opId);
		this.outbox.set(opId, {
			...entry,
			opId,
			kind: "upsert",
			path,
			textContent: entry.textContent ?? existing?.textContent,
			queuedAtMs: Date.now(),
		});
	}

	async queueRename(
		entry: Omit<SyncOutboxEntry, "opId" | "kind" | "queuedAtMs"> & { newPath: string },
	): Promise<void> {
		const path = normalizePathKey(entry.path);
		this.outbox.set(`rename:${entry.fileId ?? path}`, {
			...entry,
			opId: `rename:${entry.fileId ?? path}`,
			kind: "rename",
			path,
			newPath: normalizePathKey(entry.newPath),
			queuedAtMs: Date.now(),
		});
	}

	async queueDelete(
		entry: Omit<SyncOutboxEntry, "opId" | "kind" | "queuedAtMs">,
	): Promise<void> {
		const path = normalizePathKey(entry.path);
		this.outbox.set(`delete:${entry.fileId ?? path}`, {
			...entry,
			opId: `delete:${entry.fileId ?? path}`,
			kind: "delete",
			path,
			queuedAtMs: Date.now(),
		});
	}

	async listOutbox(): Promise<SyncOutboxEntry[]> {
		return [...this.outbox.values()].sort((left, right) => left.queuedAtMs - right.queuedAtMs);
	}

	async deleteOutbox(opId: string): Promise<void> {
		this.outbox.delete(opId);
	}

	async clear(): Promise<void> {
		this.lastSeenCursor = 0;
		this.metadataByPath.clear();
		this.metadataByFileId.clear();
		this.outbox.clear();
	}
}

let sharedStore: SyncStateStore | null = null;

export function getSyncStateStore(): SyncStateStore {
	if (sharedStore) {
		return sharedStore;
	}
	if (typeof indexedDB === "undefined") {
		sharedStore = new InMemorySyncStateStore();
		return sharedStore;
	}
	sharedStore = new IndexedDbBackedSyncStateStore();
	return sharedStore;
}
