import "fake-indexeddb/auto";
import * as Automerge from "@automerge/automerge/slim/next";
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

	test("apply_local_change_flushes_before_resolving_and_batches_push", async () => {
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
		expect(events).toEqual(["flush:start", "flush:end"]);
		await sleep(80);

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

	test("dispose_waits_for_pending_push", async () => {
		const docId = newDocId();
		const pushStarted = deferred<void>();
		const transport: DocSessionTransport = {
			pushChanges: vi.fn(async () => {
				await pushStarted.promise;
				return 1;
			}),
		};
		const session = new DocSession({ docId, repo, transport });
		await session.open();

		await session.applyLocalChange([{ pos: 0, del: 0, ins: "x" }]);
		expect(transport.pushChanges).not.toHaveBeenCalled();
		const disposing = session.dispose();
		let settled = false;
		void disposing.then(() => {
			settled = true;
		});

		await vi.waitFor(() => expect(transport.pushChanges).toHaveBeenCalledTimes(1));
		expect(transport.pushChanges).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		pushStarted.resolve();
		await disposing;
		await repo.dispose();
	});

	test("local_changes_within_50ms_share_one_push", async () => {
		const docId = newDocId();
		const transport: DocSessionTransport = {
			pushChanges: vi.fn(async () => 1),
		};
		const session = new DocSession({ docId, repo, transport });
		await session.open();

		await session.applyLocalChange([{ pos: 0, del: 0, ins: "a" }]);
		await session.applyLocalChange([{ pos: 1, del: 0, ins: "b" }]);

		expect(transport.pushChanges).not.toHaveBeenCalled();
		await sleep(80);

		expect(transport.pushChanges).toHaveBeenCalledTimes(1);
		expect(transport.pushChanges).toHaveBeenCalledWith(
			docId,
			expect.arrayContaining([expect.any(Uint8Array), expect.any(Uint8Array)]),
		);
		await repo.dispose();
	});

	test("local_pushes_are_serialized_per_doc", async () => {
		const docId = newDocId();
		const firstPushStarted = deferred<void>();
		const transport: DocSessionTransport = {
			pushChanges: vi
				.fn<DocSessionTransport["pushChanges"]>()
				.mockImplementationOnce(async () => {
					await firstPushStarted.promise;
					return 1;
				})
				.mockImplementationOnce(async () => 2),
		};
		const session = new DocSession({ docId, repo, transport });
		await session.open();

		await session.applyLocalChange([{ pos: 0, del: 0, ins: "a" }]);
		await sleep(80);
		expect(transport.pushChanges).toHaveBeenCalledTimes(1);

		await session.applyLocalChange([{ pos: 1, del: 0, ins: "b" }]);
		await sleep(80);
		expect(transport.pushChanges).toHaveBeenCalledTimes(1);

		firstPushStarted.resolve();
		await vi.waitFor(() => expect(transport.pushChanges).toHaveBeenCalledTimes(2));

		expect(transport.pushChanges).toHaveBeenCalledTimes(2);
		await repo.dispose();
	});

	test("remote_changes_can_apply_in_multiple_batches", async () => {
		const docId = newDocId();
		const onRemotePatch = vi.fn();
		const session = new DocSession({
			docId,
			repo,
			transport: pushOnlyTransport(),
			onRemotePatch,
		});
		await session.open();

		const handle = await repo.getOrCreateHandle(docId);
		const base = Automerge.clone(handle.doc());
		const first = Automerge.change(Automerge.clone(base), (doc) => {
			doc.text = "one";
		});
		const second = Automerge.change(Automerge.clone(first), (doc) => {
			doc.text = "two";
		});

		await session.applyRemoteChanges(Automerge.getChanges(base, first));
		await session.applyRemoteChanges(Automerge.getChanges(first, second));

		expect(session.getTextSnapshot()).toBe("two");
		expect(onRemotePatch).toHaveBeenLastCalledWith("two");
		await repo.dispose();
	});
});

function pushOnlyTransport(): DocSessionTransport {
	return {
		pushChanges: async () => 1,
	};
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
