export type PendingOp = {
	type: string;
	changeHash?: string;
	[key: string]: unknown;
};

export type DocMeta = {
	path: string;
	pendingSync: boolean;
};

type LocalMetaStoreOptions = {
	vaultId: string;
};

const DATABASE_VERSION = 1;
const STORE_NAME = "meta";

export class LocalMetaStore {
	private clientId: string | null = null;

	private constructor(
		private readonly db: IDBDatabase,
		readonly databaseName: string,
	) {}

	static async open(options: LocalMetaStoreOptions): Promise<LocalMetaStore> {
		const databaseName = `sync-meta-${options.vaultId}`;
		const db = await openDatabase(databaseName);
		const store = new LocalMetaStore(db, databaseName);
		await store.getClientId();
		return store;
	}

	dispose(): void {
		this.db.close();
	}

	async getClientId(): Promise<string> {
		if (this.clientId) {
			return this.clientId;
		}

		const existing = await this.getValue<string>("clientId");
		if (existing) {
			this.clientId = existing;
			logInfo("clientId loaded", { clientId: truncateUuid(existing) });
			return existing;
		}

		const generated = crypto.randomUUID();
		await this.withStore("readwrite", async (store) => {
			store.put(generated, "clientId");
		});
		this.clientId = generated;
		logInfo("new clientId generated", { clientId: truncateUuid(generated) });
		return generated;
	}

	async getDocIdForPath(path: string): Promise<string | null> {
		return (await this.getValue<string>(pathKey(path))) ?? null;
	}

	async setDocIdForPath(path: string, docId: string): Promise<void> {
		const existing = await this.getDocIdForPath(path);
		if (existing === docId) {
			return;
		}
		if (existing) {
			throw new Error(`Path ${path} is already mapped to ${existing}`);
		}

		await this.withStore("readwrite", async (store) => {
			store.put(docId, pathKey(path));
			store.put({ path, pendingSync: false } satisfies DocMeta, docKey(docId));
		});
		logInfo("path mapped", { path, docId });
	}

	async updatePathForDoc(docId: string, newPath: string): Promise<void> {
		const meta = await this.getDocMeta(docId);
		if (!meta) {
			throw new Error(`Cannot rename unknown docId ${docId}`);
		}
		if (meta.path === newPath) {
			return;
		}

		await this.withStore("readwrite", async (store) => {
			store.delete(pathKey(meta.path));
			store.put(docId, pathKey(newPath));
			store.put({ ...meta, path: newPath } satisfies DocMeta, docKey(docId));
		});
		logInfo("path renamed", { oldPath: meta.path, newPath, docId });
	}

	async removePathForDoc(docId: string): Promise<void> {
		const meta = await this.getDocMeta(docId);
		if (!meta) {
			return;
		}
		await this.withStore("readwrite", async (store) => {
			store.delete(pathKey(meta.path));
			store.delete(docKey(docId));
			store.delete(cursorKey(docId));
			store.delete(pendingKey(docId));
		});
	}

	async getDocMeta(docId: string): Promise<DocMeta | null> {
		return (await this.getValue<DocMeta>(docKey(docId))) ?? null;
	}

	async getPathMappings(): Promise<Record<string, string>> {
		return this.withStore("readonly", async (store) => {
			return new Promise<Record<string, string>>((resolve, reject) => {
				const mappings: Record<string, string> = {};
				const request = store.openCursor();

				request.onsuccess = () => {
					const cursor = request.result;
					if (!cursor) {
						resolve(mappings);
						return;
					}
					if (typeof cursor.key === "string" && cursor.key.startsWith("pathmap:")) {
						mappings[cursor.key.slice("pathmap:".length)] = cursor.value as string;
					}
					cursor.continue();
				};
				request.onerror = () => reject(request.error);
			});
		});
	}

	async getLastSyncedCursor(docId: string): Promise<string | null> {
		return (await this.getValue<string>(cursorKey(docId))) ?? null;
	}

	async setLastSyncedCursor(docId: string, cursor: string): Promise<void> {
		await this.withStore("readwrite", async (store) => {
			store.put(cursor, cursorKey(docId));
		});
	}

	async getPendingOps(docId: string): Promise<PendingOp[]> {
		return (await this.getValue<PendingOp[]>(pendingKey(docId))) ?? [];
	}

	async setPendingOps(docId: string, ops: PendingOp[]): Promise<void> {
		const snapshot = ops.map((op) => ({ ...op }));
		await this.withStore("readwrite", async (store) => {
			store.put(snapshot, pendingKey(docId));
		});
	}

	private async getValue<T>(key: string): Promise<T | undefined> {
		return this.withStore("readonly", async (store) => {
			return requestToPromise<T | undefined>(store.get(key));
		});
	}

	private async withStore<T>(
		mode: IDBTransactionMode,
		callback: (store: IDBObjectStore) => T | Promise<T>,
	): Promise<T> {
		const transaction = this.db.transaction(STORE_NAME, mode);
		const store = transaction.objectStore(STORE_NAME);
		const done = transactionDone(transaction);
		let result: T;

		try {
			result = await callback(store);
		} catch (error) {
			if (transaction.error === null) {
				transaction.abort();
			}
			await done.catch(() => undefined);
			throw error;
		}

		await done;
		return result;
	}
}

function openDatabase(databaseName: string): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName, DATABASE_VERSION);

		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME);
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		transaction.oncomplete = () => resolve();
		transaction.onabort = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
		transaction.onerror = () =>
			reject(transaction.error ?? new Error("IndexedDB transaction failed"));
	});
}

function pathKey(path: string): string {
	return `pathmap:${path}`;
}

function docKey(docId: string): string {
	return `docmap:${docId}`;
}

function cursorKey(docId: string): string {
	return `cursor:${docId}`;
}

function pendingKey(docId: string): string {
	return `pending:${docId}`;
}

function truncateUuid(uuid: string): string {
	return uuid.slice(0, 8);
}

function logInfo(message: string, data: Record<string, unknown>): void {
	console.info(`[meta] ${message}`, data);
}
