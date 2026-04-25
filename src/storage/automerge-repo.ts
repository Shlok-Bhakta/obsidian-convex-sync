import * as Automerge from "@automerge/automerge/slim/next";
import {
	Repo,
	type DocHandle,
	type DocumentId,
	type NetworkAdapterInterface,
	type StorageAdapterInterface,
} from "@automerge/automerge-repo";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";

export type AutomergeTextDoc = {
	text: string;
};

type AutomergeRepoStoreOptions = {
	vaultId: string;
	storageAdapter?: StorageAdapterInterface;
};

export function automergeRepoDatabaseName(vaultId: string): string {
	return `automerge-repo-${vaultId}`;
}

export class AutomergeRepoStore {
	readonly repo: Repo;
	readonly storageAdapter: StorageAdapterInterface;
	readonly networkAdapters: NetworkAdapterInterface[] = [];

	private readonly handles = new Map<string, Promise<DocHandle<AutomergeTextDoc>>>();

	private constructor(
		readonly databaseName: string,
		storageAdapter: StorageAdapterInterface,
	) {
		this.storageAdapter = storageAdapter;
		this.repo = new Repo({
			storage: storageAdapter,
			network: this.networkAdapters,
			saveDebounceRate: 0,
		});
	}

	static async open(options: AutomergeRepoStoreOptions): Promise<AutomergeRepoStore> {
		const databaseName = automergeRepoDatabaseName(options.vaultId);
		const storageAdapter =
			options.storageAdapter ?? new IndexedDBStorageAdapter(databaseName);
		await storageAdapter.load(["repo", "init"]);

		const store = new AutomergeRepoStore(databaseName, storageAdapter);
		await store.repo.storageId();
		console.info("[repo] initialized storage adapter", {
			databaseName,
			version: 1,
		});
		return store;
	}

	async getOrCreateHandle(docId: string): Promise<DocHandle<AutomergeTextDoc>> {
		const existing = this.handles.get(docId);
		if (existing) {
			return existing;
		}

		const pending = this.loadOrCreateHandle(docId);
		this.handles.set(docId, pending);
		return pending;
	}

	async loadDoc(docId: string): Promise<Automerge.Doc<AutomergeTextDoc>> {
		const handle = await this.getOrCreateHandle(docId);
		const doc = handle.doc();
		console.info("[repo] doc loaded from idb", {
			docId,
			byteCount: this.estimateByteCount(doc),
			changeCount: handle.metrics().numChanges,
		});
		return doc;
	}

	async ensureFlushed(docId: string): Promise<void> {
		await this.repo.flush([docId as DocumentId]);
		const handle = await this.getOrCreateHandle(docId);
		const heads = handle.heads();
		console.info("[repo] flush confirmed", {
			docId,
			incrementHash: heads.length > 0 ? heads[heads.length - 1] : null,
		});
	}

	async dispose(): Promise<void> {
		await this.repo.shutdown();
		this.handles.clear();
	}

	private async loadOrCreateHandle(
		docId: string,
	): Promise<DocHandle<AutomergeTextDoc>> {
		try {
			const handle = await this.repo.find<AutomergeTextDoc>(docId as DocumentId);
			await handle.whenReady();
			return handle;
		} catch (error) {
			if (!isUnavailableError(error)) {
				throw error;
			}
			const doc = Automerge.from<AutomergeTextDoc>({ text: "" });
			const handle = this.repo.import<AutomergeTextDoc>(Automerge.save(doc), {
				docId: docId as DocumentId,
			});
			await this.repo.flush([handle.documentId]);
			return handle;
		}
	}

	private estimateByteCount(doc: Automerge.Doc<AutomergeTextDoc>): number {
		return Automerge.save(doc).byteLength;
	}
}

function isUnavailableError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("is unavailable");
}
