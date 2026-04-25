import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	LocalMetaStore,
	type PendingOp,
} from "./local-meta-store";

const uuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
	});
}

describe("LocalMetaStore", () => {
	let vaultId: string;
	let databaseName: string;

	beforeEach(() => {
		vaultId = crypto.randomUUID();
		databaseName = `sync-meta-${vaultId}`;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await deleteDatabase(databaseName);
	});

	test("client_id_is_stable_across_reinit", async () => {
		const first = await LocalMetaStore.open({ vaultId });
		const clientId = await first.getClientId();
		first.dispose();

		const second = await LocalMetaStore.open({ vaultId });

		expect(clientId).toMatch(uuidPattern);
		expect(await second.getClientId()).toBe(clientId);
		second.dispose();
	});

	test("path_to_docid_mapping_survives_restart", async () => {
		const first = await LocalMetaStore.open({ vaultId });
		await first.setDocIdForPath("notes/a.md", "doc-a");
		first.dispose();

		const second = await LocalMetaStore.open({ vaultId });

		expect(await second.getDocIdForPath("notes/a.md")).toBe("doc-a");
		second.dispose();
	});

	test("rename_updates_path_not_docid", async () => {
		const store = await LocalMetaStore.open({ vaultId });
		await store.setDocIdForPath("a.md", "doc-a");

		await store.updatePathForDoc("doc-a", "b.md");

		expect(await store.getDocIdForPath("b.md")).toBe("doc-a");
		expect(await store.getDocMeta("doc-a")).toEqual({
			path: "b.md",
			pendingSync: false,
		});
		store.dispose();
	});

	test("old_path_is_removed_on_rename", async () => {
		const store = await LocalMetaStore.open({ vaultId });
		await store.setDocIdForPath("a.md", "doc-a");

		await store.updatePathForDoc("doc-a", "b.md");

		expect(await store.getDocIdForPath("a.md")).toBeNull();
		store.dispose();
	});

	test("set_doc_id_for_path_is_idempotent", async () => {
		const putSpy = vi.spyOn(IDBObjectStore.prototype, "put");
		const store = await LocalMetaStore.open({ vaultId });

		await store.setDocIdForPath("a.md", "doc-a");
		await store.setDocIdForPath("a.md", "doc-a");
		await store.setDocIdForPath("a.md", "doc-a");

		const pathWrites = putSpy.mock.calls.filter((call) => {
			const key = call[1];
			return typeof key === "string" && key === "pathmap:a.md";
		});
		expect(pathWrites).toHaveLength(1);
		store.dispose();
	});

	test("pending_ops_are_atomic", async () => {
		const store = await LocalMetaStore.open({ vaultId });
		const originalOps: PendingOp[] = [{ type: "push", changeHash: "a" }];
		const replacementOps: PendingOp[] = [{ type: "push", changeHash: "b" }];
		await store.setPendingOps("doc-a", originalOps);

		const originalPut = IDBObjectStore.prototype.put;
		vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
			this: IDBObjectStore,
			value: unknown,
			key?: IDBValidKey,
		) {
			const firstOp = Array.isArray(value) ? (value[0] as PendingOp | undefined) : undefined;
			if (key === "pending:doc-a" && firstOp?.changeHash === "b") {
				throw new Error("simulated IDB abort");
			}
			return originalPut.call(this, value, key);
		});

		await expect(store.setPendingOps("doc-a", replacementOps)).rejects.toThrow(
			"simulated IDB abort",
		);
		expect(await store.getPendingOps("doc-a")).toEqual(originalOps);
		store.dispose();
	});

	test("cursor_is_per_doc_not_global", async () => {
		const store = await LocalMetaStore.open({ vaultId });

		await store.setLastSyncedCursor("doc-a", "cursor-a");

		expect(await store.getLastSyncedCursor("doc-a")).toBe("cursor-a");
		expect(await store.getLastSyncedCursor("doc-b")).toBeNull();
		store.dispose();
	});

	test("meta_store_survives_concurrent_writes", async () => {
		const store = await LocalMetaStore.open({ vaultId });

		await Promise.all([
			store.setLastSyncedCursor("doc-a", "cursor-a"),
			store.setLastSyncedCursor("doc-b", "cursor-b"),
			store.setLastSyncedCursor("doc-c", "cursor-c"),
		]);

		expect(await store.getLastSyncedCursor("doc-a")).toBe("cursor-a");
		expect(await store.getLastSyncedCursor("doc-b")).toBe("cursor-b");
		expect(await store.getLastSyncedCursor("doc-c")).toBe("cursor-c");
		store.dispose();
	});

	test("reconciled_base_survives_restart", async () => {
		const first = await LocalMetaStore.open({ vaultId });
		await first.setDocIdForPath("notes/a.md", "doc-a");
		await first.setLastReconciledText("doc-a", "merged text");
		first.dispose();

		const second = await LocalMetaStore.open({ vaultId });
		const meta = await second.getDocMeta("doc-a");

		expect(await second.getLastReconciledText("doc-a")).toBe("merged text");
		expect(meta?.lastReconciledHash).toMatch(/^[0-9a-f]{64}$/);
		expect(meta?.lastReconciledAtMs).toBeTypeOf("number");
		second.dispose();
	});

	test("with_store_rejects_cleanly_after_dispose_starts", async () => {
		const store = await LocalMetaStore.open({ vaultId });
		store.dispose();

		await expect(store.setLastSyncedCursor("doc-a", "cursor-a")).rejects.toThrow(
			"is closing",
		);
	});
});
