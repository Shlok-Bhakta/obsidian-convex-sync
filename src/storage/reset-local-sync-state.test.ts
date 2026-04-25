import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { AutomergeRepoStore } from "./automerge-repo";
import { LocalMetaStore } from "./local-meta-store";
import { resetLocalSyncState } from "./reset-local-sync-state";

describe("resetLocalSyncState", () => {
	test("deletes local meta and automerge IndexedDB databases for the vault", async () => {
		const vaultId = crypto.randomUUID();
		const meta = await LocalMetaStore.open({ vaultId });
		await meta.setDocIdForPath("note.md", "doc-a");
		meta.dispose();

		const repo = await AutomergeRepoStore.open({ vaultId });
		await repo.dispose({ closeStorage: true });

		const result = await resetLocalSyncState(vaultId);

		expect(result.databaseNames).toEqual([
			`sync-meta-${vaultId}`,
			`automerge-repo-${vaultId}`,
		]);

		const nextMeta = await LocalMetaStore.open({ vaultId });
		expect(await nextMeta.getDocIdForPath("note.md")).toBeNull();
		nextMeta.dispose();
		await resetLocalSyncState(vaultId);
	});
});
