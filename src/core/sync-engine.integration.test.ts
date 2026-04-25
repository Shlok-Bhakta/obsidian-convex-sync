import "fake-indexeddb/auto";
import type { ConvexClient } from "convex/browser";
import { beforeEach, describe, expect, test } from "vitest";
import { SyncEngine } from "./sync-engine";

const SECRET = "test-secret";
const PATH = "shared.md";

describe("SyncEngine integration", () => {
	let client: FakeConvexClient;
	let server: SharedAutomergeServer;
	let engine: SyncEngine;
	let vaultId: string;

	beforeEach(async () => {
		server = new SharedAutomergeServer();
		client = new FakeConvexClient(server);
		vaultId = crypto.randomUUID();
		engine = await SyncEngine.boot({
			vaultId,
			convexClient: client as unknown as ConvexClient,
			convexSecret: SECRET,
		});
	});

	test("reconcilePath keeps local-only text and reuses it as base", async () => {
		const first = await engine.reconcilePath(PATH, "hello");
		const second = await engine.reconcilePath(PATH, "hello");

		expect(first.text).toBe("hello");
		expect(second.text).toBe("hello");
		expect(second.changed).toBe(false);
		await engine.dispose();
		client.kill();
	});

	test("reopening_same_doc_reuses_subscription", async () => {
		const first = await engine.openDoc(PATH);
		expect(client.subscriptionCount()).toBe(1);

		const second = await engine.openDoc(PATH);

		expect(second.docId).toBe(first.docId);
		expect(client.subscriptionCount()).toBe(1);
		second.close();
		await engine.dispose();
		client.kill();
	});

	test("remote update can win when desktop has no reconciled base", async () => {
		const mobileClient = new FakeConvexClient(server);
		const mobileEngine = await SyncEngine.boot({
			vaultId: crypto.randomUUID(),
			convexClient: mobileClient as unknown as ConvexClient,
			convexSecret: SECRET,
		});
		await mobileEngine.reconcilePath(PATH, "old content");
		await sleep(80);
		await mobileEngine.reconcilePath(PATH, "");
		await sleep(80);

		const result = await engine.reconcilePath(PATH, "old content", {
			preferRemoteOnMissingBase: true,
		});

		expect(result.text).toBe("");
		expect(result.changed).toBe(true);
		expect(result.usedFallbackBackup).toBe(false);
		await mobileEngine.dispose();
		mobileClient.kill();
		await engine.dispose();
		client.kill();
	});
});

class SharedAutomergeServer {
	private rows: ServerChange[] = [];
	private readonly pathMappings = new Map<string, string>();
	private cursor = 0;
	private readonly clients = new Set<FakeConvexClient>();

	register(client: FakeConvexClient): void {
		this.clients.add(client);
	}

	unregister(client: FakeConvexClient): void {
		this.clients.delete(client);
	}

	async submit(args: SubmitChangesArgs): Promise<{
		ok: true;
		duplicate: boolean;
		inserted: number;
		serverCursor: number;
	}> {
		let inserted = 0;
		let serverCursor = 0;
		for (const change of args.changes) {
			const bytes = new Uint8Array(change.data);
			const hash = await sha256Hex(bytes);
			this.cursor += 1;
			serverCursor = this.cursor;
			this.rows.push({
				docId: args.docId,
				type: change.type,
				hash,
				data: bytes,
				clientId: args.clientId,
				idempotencyKey: args.idempotencyKey,
				serverCursor,
			});
			inserted += 1;
		}
		this.notify();
		return { ok: true, duplicate: false, inserted, serverCursor };
	}

	getOrCreateDocIdForPath(args: PathMappingArgs): { docId: string; created: boolean } {
		const existing = this.pathMappings.get(args.path);
		if (existing) {
			return { docId: existing, created: false };
		}
		this.pathMappings.set(args.path, args.candidateDocId);
		return { docId: args.candidateDocId, created: true };
	}

	pull(args: PullChangesArgs): PullResult {
		return {
			page: this.rows
				.filter((row) => row.docId === args.docId && row.serverCursor > args.sinceCursor)
				.map((row) => ({
					id: row.hash,
					docId: row.docId,
					type: row.type,
					hash: row.hash,
					data: toArrayBuffer(row.data),
					clientId: row.clientId,
					idempotencyKey: row.idempotencyKey,
					serverCursor: row.serverCursor,
				})),
			isDone: true,
			continueCursor: "",
			splitCursor: "",
			pageStatus: "SplitRecommended",
		};
	}

	getLatestCursor(args: LatestCursorArgs): number {
		return this.rows
			.filter((row) => row.docId === args.docId)
			.reduce((max, row) => Math.max(max, row.serverCursor), 0);
	}

	private notify(): void {
		for (const client of this.clients) {
			client.notifySubscribers();
		}
	}
}

class FakeConvexClient {
	private readonly subscribers = new Set<Subscriber>();

	constructor(private readonly server: SharedAutomergeServer) {
		server.register(this);
	}

	connectionState() {
		return { isWebSocketConnected: true, hasEverConnected: true };
	}

	subscribeToConnectionState(): () => void {
		return () => undefined;
	}

	onUpdate(
		_query: unknown,
		args: PullChangesArgs | LatestCursorArgs,
		callback: (result: PullResult | number) => unknown,
	): FakeUnsubscribe {
		const subscriber = { args, callback };
		this.subscribers.add(subscriber);
		queueMicrotask(() => subscriber.callback(this.getSubscriptionValue(args)));
		const unsubscribe = (() => {
			this.subscribers.delete(subscriber);
		}) as FakeUnsubscribe;
		unsubscribe.unsubscribe = unsubscribe;
		unsubscribe.getCurrentValue = () => this.getSubscriptionValue(args);
		return unsubscribe;
	}

	async mutation(_mutation: unknown, args: SubmitChangesArgs | PathMappingArgs): Promise<unknown> {
		if ("candidateDocId" in args) {
			return this.server.getOrCreateDocIdForPath(args);
		}
		return this.server.submit(args);
	}

	async query(_query: unknown, args: PullChangesArgs): Promise<PullResult> {
		return this.server.pull(args);
	}

	notifySubscribers(): void {
		for (const subscriber of this.subscribers) {
			subscriber.callback(this.getSubscriptionValue(subscriber.args));
		}
	}

	kill(): void {
		this.subscribers.clear();
		this.server.unregister(this);
	}

	subscriptionCount(): number {
		return this.subscribers.size;
	}

	private getSubscriptionValue(args: PullChangesArgs | LatestCursorArgs): PullResult | number {
		if ("sinceCursor" in args) {
			return this.server.pull(args);
		}
		return this.server.getLatestCursor(args);
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

type ServerChange = {
	docId: string;
	type: "incremental" | "snapshot";
	hash: string;
	data: Uint8Array;
	clientId: string;
	idempotencyKey: string;
	serverCursor: number;
};

type SubmitChangesArgs = {
	docId: string;
	clientId: string;
	idempotencyKey: string;
	changes: Array<{
		type: "incremental" | "snapshot";
		data: ArrayBuffer;
	}>;
};

type PathMappingArgs = {
	path: string;
	candidateDocId: string;
};

type PullChangesArgs = {
	docId: string;
	sinceCursor: number;
	numItems?: number;
	cursor?: string;
};

type LatestCursorArgs = {
	docId: string;
};

type PullResult = {
	page: Array<{
		id: string;
		docId: string;
		type: "incremental" | "snapshot";
		hash: string;
		data: ArrayBuffer;
		clientId: string;
		idempotencyKey: string;
		serverCursor: number;
	}>;
	isDone: boolean;
	continueCursor: string;
	splitCursor: string;
	pageStatus: "SplitRecommended";
};

type Subscriber = {
	args: PullChangesArgs | LatestCursorArgs;
	callback: (result: PullResult | number) => unknown;
};

type FakeUnsubscribe = (() => void) & {
	unsubscribe: () => void;
	getCurrentValue: () => PullResult | number;
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
