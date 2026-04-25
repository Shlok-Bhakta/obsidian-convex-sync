import type { ConvexClient } from "convex/browser";
import { describe, expect, test, vi } from "vitest";
import {
	ConvexAutomergeTransport,
	derivePushIdempotencyKey,
} from "./convex-client";

const SECRET = "secret";
const CLIENT_ID = "client-a";
const DOC_ID = "doc-1";

describe("ConvexAutomergeTransport", () => {
	test("push_changes_uses_deterministic_idempotency_key", async () => {
		const client = new FakeConvexClient();
		const transport = createTransport(client);
		const changes = [new Uint8Array([1, 2]), new Uint8Array([3])];

		const cursor = await transport.pushChanges(DOC_ID, changes);

		expect(cursor).toBe(42);
		expect(client.mutations).toHaveLength(1);
		expect(client.mutations[0]?.args).toMatchObject({
			convexSecret: SECRET,
			docId: DOC_ID,
			clientId: CLIENT_ID,
			idempotencyKey: await derivePushIdempotencyKey(CLIENT_ID, DOC_ID, changes),
		});
		expect(client.mutations[0]?.args.changes.map((change) => change.type)).toEqual([
			"incremental",
			"incremental",
		]);
	});

	test("push_changes_skips_empty_batches", async () => {
		const client = new FakeConvexClient();
		const transport = createTransport(client);

		await expect(transport.pushChanges(DOC_ID, [])).resolves.toBe(0);

		expect(client.mutations).toHaveLength(0);
	});

	test("push_snapshot_submits_snapshot_type", async () => {
		const client = new FakeConvexClient();
		const transport = createTransport(client);

		await transport.pushSnapshot(DOC_ID, new Uint8Array([9, 9]));

		expect(client.mutations[0]?.args.changes[0]?.type).toBe("snapshot");
		expect(client.mutations[0]?.args.changes[0]?.data).toBeInstanceOf(ArrayBuffer);
	});

	test("pull_missing_changes_reads_all_pages", async () => {
		const client = new FakeConvexClient();
		client.queryPages = [
			{
				page: [remoteChange("a", "incremental", 10, [1])],
				isDone: false,
				continueCursor: "next",
				splitCursor: "",
				pageStatus: "SplitRecommended",
			},
			{
				page: [remoteChange("b", "snapshot", 11, [2, 3])],
				isDone: true,
				continueCursor: "",
				splitCursor: "",
				pageStatus: "SplitRecommended",
			},
		];
		const transport = createTransport(client);

		const changes = await transport.pullMissingChanges(DOC_ID, 7);

		expect(client.queries.map((query) => query.args.cursor)).toEqual([undefined, "next"]);
		expect(changes.map((change) => Array.from(change.data))).toEqual([[1], [2, 3]]);
		expect(changes.map((change) => change.type)).toEqual(["incremental", "snapshot"]);
	});

	test("watch_doc_pulls_missing_pages_and_dedupes_by_type_and_hash", async () => {
		const client = new FakeConvexClient();
		const transport = createTransport(client);
		const onChanges = vi.fn();
		client.queryPages = [
			{
				page: [
					remoteChange("same", "incremental", 1, [1]),
					remoteChange("same", "snapshot", 2, [1]),
					remoteChange("same", "incremental", 3, [1]),
				],
				isDone: true,
				continueCursor: "",
				splitCursor: "",
				pageStatus: "SplitRecommended",
			},
		];

		transport.watchDoc(DOC_ID, onChanges);
		client.emitUpdate(3);
		await vi.waitFor(() => expect(onChanges).toHaveBeenCalledTimes(1));

		const emitted = onChanges.mock.calls[0]?.[0] as RemoteChange[];
		expect(emitted.map((change) => change.type)).toEqual([
			"incremental",
			"snapshot",
		]);
	});
});

function createTransport(client: FakeConvexClient): ConvexAutomergeTransport {
	return new ConvexAutomergeTransport({
		client: client as unknown as ConvexClient,
		convexSecret: SECRET,
		clientId: CLIENT_ID,
	});
}

function remoteChange(
	hash: string,
	type: "incremental" | "snapshot",
	serverCursor: number,
	data: number[],
): RemoteChange {
	return {
		id: `${type}:${hash}:${serverCursor}`,
		docId: DOC_ID,
		type,
		hash,
		data: new Uint8Array(data).buffer,
		clientId: "remote-client",
		idempotencyKey: "remote-key",
		serverCursor,
	};
}

class FakeConvexClient {
	mutations: Array<{ args: SubmitChangesArgs }> = [];
	queries: Array<{ args: PullChangesArgs }> = [];
	queryPages: PullResult[] = [];
	private updateCallback: ((result: number) => void) | null = null;

	connectionState() {
		return { isWebSocketConnected: true, hasEverConnected: true };
	}

	subscribeToConnectionState(): () => void {
		return () => undefined;
	}

	onUpdate(
		_query: unknown,
		_args: { docId: string },
		callback: (result: number) => void,
	): () => void {
		this.updateCallback = callback;
		return () => {
			this.updateCallback = null;
		};
	}

	async mutation(_mutation: unknown, args: SubmitChangesArgs) {
		this.mutations.push({ args });
		return { ok: true, duplicate: false, inserted: args.changes.length, serverCursor: 42 };
	}

	async query(_query: unknown, args: PullChangesArgs): Promise<PullResult> {
		this.queries.push({ args });
		const page = this.queryPages.shift();
		if (!page) {
			throw new Error("No query page queued");
		}
		return page;
	}

	emitUpdate(result: number): void {
		this.updateCallback?.(result);
	}
}

type SubmitChangesArgs = {
	convexSecret: string;
	docId: string;
	clientId: string;
	idempotencyKey: string;
	changes: Array<{
		type: "incremental" | "snapshot";
		data: ArrayBuffer;
	}>;
};

type PullChangesArgs = {
	convexSecret: string;
	docId: string;
	sinceCursor: number;
	numItems?: number;
	cursor?: string;
};

type PullResult = {
	page: RemoteChange[];
	isDone: boolean;
	continueCursor: string;
	splitCursor: string;
	pageStatus: "SplitRecommended";
};

type RemoteChange = {
	id: string;
	docId: string;
	type: "incremental" | "snapshot";
	hash: string;
	data: ArrayBuffer;
	clientId: string;
	idempotencyKey: string;
	serverCursor: number;
};
