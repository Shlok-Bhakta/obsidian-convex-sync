import "fake-indexeddb/auto";
import { generateAutomergeUrl, parseAutomergeUrl } from "@automerge/automerge-repo";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { beforeEach, describe, expect, test } from "vitest";
import {
	AutomergeRepoStore,
	type AutomergeTextDoc,
} from "./automerge-repo";

function newDocId(): string {
	return parseAutomergeUrl(generateAutomergeUrl()).documentId;
}

describe("AutomergeRepoStore", () => {
	let vaultId: string;
	let databaseName: string;

	beforeEach(() => {
		vaultId = crypto.randomUUID();
		databaseName = `automerge-repo-${vaultId}`;
	});

	test("repo_initializes_with_indexeddb_adapter", async () => {
		const store = await AutomergeRepoStore.open({ vaultId });

		expect(store.storageAdapter).toBeInstanceOf(IndexedDBStorageAdapter);
		expect(store.networkAdapters).toHaveLength(0);

		await store.dispose();
	});

	test("new_doc_handle_is_empty_on_first_load", async () => {
		const store = await AutomergeRepoStore.open({ vaultId });

		const handle = await store.getOrCreateHandle(newDocId());

		expect(handle.doc().text).toBe("");
		await store.dispose();
	});

	test("persisted_doc_survives_repo_dispose_and_reinit", async () => {
		const docId = newDocId();
		let store = await AutomergeRepoStore.open({ vaultId });
		const handle = await store.getOrCreateHandle(docId);
		handle.change((doc: AutomergeTextDoc) => {
			doc.text = "offline text";
		});
		await store.ensureFlushed(docId);
		await store.dispose();

		store = await AutomergeRepoStore.open({ vaultId });
		const loaded = await store.loadDoc(docId);

		expect(loaded.text).toBe("offline text");
		await store.dispose();
	});

	test("ensure_flushed_blocks_until_idb_write_confirmed", async () => {
		const storageAdapter = new DelayedSaveAdapter(databaseName, 200);
		const store = await AutomergeRepoStore.open({ vaultId, storageAdapter });
		const handle = await store.getOrCreateHandle(newDocId());
		handle.change((doc: AutomergeTextDoc) => {
			doc.text = "delayed";
		});

		const startedAt = performance.now();
		await store.ensureFlushed(handle.documentId);

		expect(performance.now() - startedAt).toBeGreaterThanOrEqual(190);
		await store.dispose();
	});

	test("concurrent_handle_requests_return_same_handle", async () => {
		const store = await AutomergeRepoStore.open({ vaultId });
		const docId = newDocId();

		const handles = await Promise.all([
			store.getOrCreateHandle(docId),
			store.getOrCreateHandle(docId),
			store.getOrCreateHandle(docId),
		]);

		expect(handles[0]).toBe(handles[1]);
		expect(handles[1]).toBe(handles[2]);
		await store.dispose();
	});
});

class DelayedSaveAdapter extends IndexedDBStorageAdapter {
	constructor(
		databaseName: string,
		private readonly delayMs: number,
	) {
		super(databaseName);
	}

	override async save(keyArray: string[], binary: Uint8Array): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, this.delayMs));
		await super.save(keyArray, binary);
	}
}
