import "fake-indexeddb/auto";
import { generateAutomergeUrl, parseAutomergeUrl } from "@automerge/automerge-repo";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AutomergeRepoStore } from "../storage/automerge-repo";
import { DocSession, type DocSessionTransport } from "./doc-session";

function newDocId(): string {
	return parseAutomergeUrl(generateAutomergeUrl()).documentId;
}

describe("DocSession", () => {
	let vaultId: string;
	let repo: AutomergeRepoStore;

	beforeEach(async () => {
		vaultId = crypto.randomUUID();
		repo = await AutomergeRepoStore.open({ vaultId });
	});

	test("open_emits_initial_state_from_idb", async () => {
		const docId = newDocId();
		const handle = await repo.getOrCreateHandle(docId);
		handle.change((doc) => {
			doc.text = "offline";
		});
		await repo.ensureFlushed(docId);
		const onStateChange = vi.fn();

		const session = new DocSession({
			docId,
			repo,
			transport: pushOnlyTransport(),
			onStateChange,
		});
		await session.open();

		expect(onStateChange).toHaveBeenCalledWith("offline");
		await repo.dispose();
	});

	test("apply_local_change_flushes_before_resolving_and_push", async () => {
		const docId = newDocId();
		const events: string[] = [];
		const originalEnsureFlushed = repo.ensureFlushed.bind(repo);
		vi.spyOn(repo, "ensureFlushed").mockImplementation(async (flushedDocId) => {
			events.push("flush:start");
			await originalEnsureFlushed(flushedDocId);
			events.push("flush:end");
		});
		const transport: DocSessionTransport = {
			pushChanges: vi.fn(async () => {
				events.push("push");
				return 1;
			}),
		};
		const session = new DocSession({ docId, repo, transport });
		await session.open();

		await session.applyLocalChange([{ pos: 0, del: 0, ins: "x" }]);

		expect(session.getTextSnapshot()).toBe("x");
		expect(events).toEqual(["flush:start", "flush:end", "push"]);
		await repo.dispose();
	});

	test("get_text_snapshot_reads_live_doc_not_cache", async () => {
		const docId = newDocId();
		const session = new DocSession({
			docId,
			repo,
			transport: pushOnlyTransport(),
		});
		await session.open();

		await session.applyLocalChange([{ pos: 0, del: 0, ins: "live" }]);

		expect(session.getTextSnapshot()).toBe("live");
		await repo.dispose();
	});
});

function pushOnlyTransport(): DocSessionTransport {
	return {
		pushChanges: async () => 1,
	};
}
