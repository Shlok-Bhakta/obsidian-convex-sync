import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalMetaStore } from "../storage/local-meta-store";
import { PathConflictError, PathMap } from "./path-map";

async function deleteDatabase(name: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const request = indexedDB.deleteDatabase(name);
		request.onsuccess = () => resolve();
		request.onerror = () => reject(request.error);
		request.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
	});
}

describe("PathMap", () => {
	let vaultId: string;
	let databaseName: string;
	let store: LocalMetaStore;

	beforeEach(async () => {
		vaultId = crypto.randomUUID();
		databaseName = `sync-meta-${vaultId}`;
		store = await LocalMetaStore.open({ vaultId });
	});

	afterEach(async () => {
		store.dispose();
		await deleteDatabase(databaseName);
	});

	test("get_or_create_is_stable", async () => {
		const pathMap = new PathMap(store);

		const docIds = await Promise.all([
			pathMap.getOrCreate("a.md"),
			pathMap.getOrCreate("a.md"),
			pathMap.getOrCreate("a.md"),
			pathMap.getOrCreate("a.md"),
			pathMap.getOrCreate("a.md"),
		]);

		expect(new Set(docIds).size).toBe(1);
	});

	test("different_paths_get_different_doc_ids", async () => {
		const pathMap = new PathMap(store);

		const first = await pathMap.getOrCreate("a.md");
		const second = await pathMap.getOrCreate("b.md");

		expect(first).not.toBe(second);
	});

	test("rename_preserves_doc_id", async () => {
		const pathMap = new PathMap(store);
		const docId = await pathMap.getOrCreate("a.md");

		await pathMap.rename("a.md", "b.md");

		expect(await pathMap.getDocId("b.md")).toBe(docId);
	});

	test("rename_removes_old_path", async () => {
		const pathMap = new PathMap(store);
		await pathMap.getOrCreate("a.md");

		await pathMap.rename("a.md", "b.md");

		expect(await pathMap.getDocId("a.md")).toBeNull();
	});

	test("rename_to_existing_path_throws", async () => {
		const pathMap = new PathMap(store);
		await pathMap.getOrCreate("a.md");
		await pathMap.getOrCreate("b.md");

		await expect(pathMap.rename("a.md", "b.md")).rejects.toBeInstanceOf(
			PathConflictError,
		);
	});

	test("rename_to_existing_path_leaves_both_mappings_intact", async () => {
		const pathMap = new PathMap(store);
		const docA = await pathMap.getOrCreate("a.md");
		const docB = await pathMap.getOrCreate("b.md");

		await expect(pathMap.rename("a.md", "b.md")).rejects.toBeInstanceOf(
			PathConflictError,
		);

		expect(await pathMap.getDocId("a.md")).toBe(docA);
		expect(await pathMap.getDocId("b.md")).toBe(docB);
	});

	test("get_all_mappings_returns_copy", async () => {
		const pathMap = new PathMap(store);
		const docId = await pathMap.getOrCreate("a.md");

		const mappings = await pathMap.getAllMappings();
		mappings["a.md"] = "mutated";

		expect(await pathMap.getAllMappings()).toEqual({ "a.md": docId });
	});

	test("mapping_survives_meta_store_restart", async () => {
		let pathMap = new PathMap(store);
		const docId = await pathMap.getOrCreate("a.md");
		store.dispose();

		store = await LocalMetaStore.open({ vaultId });
		pathMap = new PathMap(store);

		expect(await pathMap.getDocId("a.md")).toBe(docId);
	});
});
