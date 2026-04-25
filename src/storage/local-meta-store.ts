export type PendingOp = {
	type: string;
	changeHash?: string;
	[key: string]: unknown;
};

export type DocMeta = {
	path: string;
	pendingSync: boolean;
	lastReconciledText?: string;
	lastReconciledHash?: string;
	lastReconciledAtMs?: number;
};

type LocalMetaStoreOptions = {
	vaultId: string;
};

const DATABASE_VERSION = 1;
const STORE_NAME = "meta";

export function localMetaDatabaseName(vaultId: string): string {
	return `sync-meta-${vaultId}`;
}

export class LocalMetaStore {
	private clientId: string | null = null;
	private disposing = false;
	private disposed = false;

	private constructor(
		private readonly db: IDBDatabase,
		readonly databaseName: string,
	) {}

	static async open(options: LocalMetaStoreOptions): Promise<LocalMetaStore> {
		const databaseName = localMetaDatabaseName(options.vaultId);
		const db = await openDatabase(databaseName);
		const store = new LocalMetaStore(db, databaseName);
		await store.getClientId();
		return store;
	}

	dispose(): void {
		if (this.disposing || this.disposed) {
			return;
		}
		this.disposing = true;
		this.db.close();
		this.disposed = true;
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

	async getLastReconciledText(docId: string): Promise<string | null> {
		return (await this.getDocMeta(docId))?.lastReconciledText ?? null;
	}

	async setLastReconciledText(docId: string, text: string): Promise<void> {
		const meta = await this.getDocMeta(docId);
		if (!meta) {
			throw new Error(`Cannot persist reconciled text for unknown docId ${docId}`);
		}
		const hash = await sha256Hex(text);
		if (
			meta.lastReconciledText === text &&
			meta.lastReconciledHash === hash
		) {
			return;
		}

		await this.withStore("readwrite", async (store) => {
			store.put(
				{
					...meta,
					lastReconciledText: text,
					lastReconciledHash: hash,
					lastReconciledAtMs: Date.now(),
				} satisfies DocMeta,
				docKey(docId),
			);
		});
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
		if (this.disposing || this.disposed) {
			throw new LocalMetaStoreClosedError(this.databaseName);
		}
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

export class LocalMetaStoreClosedError extends Error {
	constructor(databaseName: string) {
		super(`Local meta store ${databaseName} is closing`);
		this.name = "LocalMetaStoreClosedError";
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

async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function logInfo(message: string, data: Record<string, unknown>): void {
	console.info(`[meta] ${message}`, data);
}
