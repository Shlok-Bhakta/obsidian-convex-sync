import "fake-indexeddb/auto";
import type { ConvexClient } from "convex/browser";
import { beforeEach, describe, expect, test } from "vitest";
import { LocalMetaStore } from "../storage/local-meta-store";
import { SyncEngine, type OpenDocumentSession } from "./sync-engine";

const SECRET = "test-secret";
const PATH = "shared.md";

describe("SyncEngine integration scenarios", () => {
	let server: SharedAutomergeServer;
	let runId: string;

	beforeEach(() => {
		server = new SharedAutomergeServer();
		runId = crypto.randomUUID();
	});

	test("two_clients_converge_after_many_sequential_writes", async () => {
		const clientA = await SimulatedClient.boot(clientId(runId, "a"), server);
		const docA = await clientA.open(PATH);
		await server.waitForDocRows(docA.docId, 1);

		const clientB = await SimulatedClient.boot(clientId(runId, "b"), server, {
			path: PATH,
			docId: docA.docId,
		});
		const docB = await clientB.open(PATH);

		const expected = await writeCharacters(docA, "abcdefghijklmnopqrstuvwxyz");

		await waitFor(() => docB.getTextSnapshot() === expected);
		expect(docA.getTextSnapshot()).toBe(expected);
		expect(docB.getTextSnapshot()).toBe(expected);

		await clientA.dispose();
		await clientB.dispose();
	});

	test("offline_burst_reconnects_and_recovers_exact_text", async () => {
		const clientA = await SimulatedClient.boot(clientId(runId, "a"), server);
		const docA = await clientA.open(PATH);
		await server.waitForDocRows(docA.docId, 1);

		const clientB = await SimulatedClient.boot(clientId(runId, "b"), server, {
			path: PATH,
			docId: docA.docId,
		});
		const docB = await clientB.open(PATH);

		clientA.drop();
		const expected = await writeCharacters(docA, "offline ".repeat(30));
		expect(docA.getTextSnapshot()).toBe(expected);
		expect(docB.getTextSnapshot()).toBe("");

		clientA.restore();

		await waitFor(() => docB.getTextSnapshot() === expected, 5_000);
		expect(docA.getTextSnapshot()).toBe(expected);
		expect(docB.getTextSnapshot()).toBe(expected);

		await clientA.dispose();
		await clientB.dispose();
	});

	test("two_clients_edit_during_partition_then_converge", async () => {
		const clientA = await SimulatedClient.boot(clientId(runId, "a"), server);
		const docA = await clientA.open(PATH);
		await server.waitForDocRows(docA.docId, 1);

		const clientB = await SimulatedClient.boot(clientId(runId, "b"), server, {
			path: PATH,
			docId: docA.docId,
		});
		const docB = await clientB.open(PATH);

		clientA.drop();
		clientB.drop();
		await writeCharacters(docA, "AAAAA");
		await writeCharacters(docB, "BBBBB");

		clientA.restore();
		clientB.restore();

		await waitFor(
			() =>
				docA.getTextSnapshot() === docB.getTextSnapshot() &&
				docA.getTextSnapshot().includes("AAAAA") &&
				docA.getTextSnapshot().includes("BBBBB"),
			5_000,
		);
		expect(docA.getTextSnapshot()).toBe(docB.getTextSnapshot());

		await clientA.dispose();
		await clientB.dispose();
	});

	test("reboot_after_offline_local_flush_pushes_snapshot_and_recovers_peer", async () => {
		let clientA = await SimulatedClient.boot(clientId(runId, "a"), server);
		const docA = await clientA.open(PATH);
		await server.waitForDocRows(docA.docId, 1);

		const clientB = await SimulatedClient.boot(clientId(runId, "b"), server, {
			path: PATH,
			docId: docA.docId,
		});
		const docB = await clientB.open(PATH);

		clientA.drop();
		const expected = await writeCharacters(docA, "survives reboot");
		await clientA.killProcess();

		clientA = await SimulatedClient.boot(clientId(runId, "a"), server, {
			path: PATH,
			docId: docA.docId,
		});
		await clientA.open(PATH);
		clientA.restore();

		await waitFor(() => docB.getTextSnapshot() === expected, 5_000);
		expect(docB.getTextSnapshot()).toBe(expected);

		await clientA.dispose();
		await clientB.dispose();
	});

	test("three_clients_partitioned_bursts_all_converge", async () => {
		const clientA = await SimulatedClient.boot(clientId(runId, "a"), server);
		const docA = await clientA.open(PATH);
		await server.waitForDocRows(docA.docId, 1);
		const clientB = await SimulatedClient.boot(clientId(runId, "b"), server, {
			path: PATH,
			docId: docA.docId,
		});
		const clientC = await SimulatedClient.boot(clientId(runId, "c"), server, {
			path: PATH,
			docId: docA.docId,
		});
		const docB = await clientB.open(PATH);
		const docC = await clientC.open(PATH);

		clientA.drop();
		clientB.drop();
		clientC.drop();
		await writeCharacters(docA, "alpha-".repeat(20));
		await writeCharacters(docB, "bravo-".repeat(20));
		await writeCharacters(docC, "charlie-".repeat(20));

		clientA.restore();
		clientB.restore();
		clientC.restore();

		await waitFor(
			() =>
				docA.getTextSnapshot() === docB.getTextSnapshot() &&
				docB.getTextSnapshot() === docC.getTextSnapshot() &&
				docA.getTextSnapshot().includes("alpha-") &&
				docA.getTextSnapshot().includes("bravo-") &&
				docA.getTextSnapshot().includes("charlie-"),
			8_000,
		);
		expect(docA.getTextSnapshot()).toBe(docB.getTextSnapshot());
		expect(docB.getTextSnapshot()).toBe(docC.getTextSnapshot());

		await clientA.dispose();
		await clientB.dispose();
		await clientC.dispose();
	});

	test("repeated_drop_restore_cycles_preserve_exact_text", async () => {
		const clientA = await SimulatedClient.boot(clientId(runId, "a"), server);
		const docA = await clientA.open(PATH);
		await server.waitForDocRows(docA.docId, 1);
		const clientB = await SimulatedClient.boot(clientId(runId, "b"), server, {
			path: PATH,
			docId: docA.docId,
		});
		const docB = await clientB.open(PATH);

		let expected = "";
		for (let cycle = 0; cycle < 6; cycle += 1) {
			clientA.drop();
			expected = await writeCharacters(docA, `cycle-${cycle}-`.repeat(12));
			clientA.restore();
			await waitFor(() => docB.getTextSnapshot() === expected, 5_000);
			expect(docA.getTextSnapshot()).toBe(expected);
			expect(docB.getTextSnapshot()).toBe(expected);
		}

		await clientA.dispose();
		await clientB.dispose();
	});
});

function clientId(runId: string, name: string): string {
	return `${runId}-${name}`;
}

class SimulatedClient {
	private constructor(
		readonly id: string,
		private readonly fakeClient: FakeConvexClient,
		private readonly engine: SyncEngine,
	) {}

	static async boot(
		id: string,
		server: SharedAutomergeServer,
		mapping?: { path: string; docId: string },
	): Promise<SimulatedClient> {
		if (mapping) {
			const meta = await LocalMetaStore.open({ vaultId: id });
			await meta.setDocIdForPath(mapping.path, mapping.docId);
			meta.dispose();
		}
		const fakeClient = new FakeConvexClient(server);
		const engine = await SyncEngine.boot({
			vaultId: id,
			convexClient: fakeClient as unknown as ConvexClient,
			convexSecret: SECRET,
		});
		return new SimulatedClient(id, fakeClient, engine);
	}

	open(path: string): Promise<OpenDocumentSession> {
		return this.engine.openDoc(path);
	}

	drop(): void {
		this.fakeClient.drop();
	}

	restore(): void {
		this.fakeClient.restore();
	}

	async killProcess(): Promise<void> {
		this.fakeClient.kill();
		await this.engine.dispose();
	}

	async dispose(): Promise<void> {
		await this.engine.dispose();
		this.fakeClient.kill();
	}
}

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
		const existingKeyRows = this.rows.filter(
			(row) =>
				row.docId === args.docId && row.idempotencyKey === args.idempotencyKey,
		);
		if (existingKeyRows.length > 0) {
			return {
				ok: true,
				duplicate: true,
				inserted: 0,
				serverCursor: Math.max(...existingKeyRows.map((row) => row.serverCursor)),
			};
		}

		let inserted = 0;
		let serverCursor = 0;
		for (const change of args.changes) {
			const bytes = new Uint8Array(change.data);
			const hash = await sha256Hex(bytes);
			const existingHash = this.rows.find(
				(row) =>
					row.docId === args.docId &&
					row.type === change.type &&
					row.hash === hash,
			);
			if (existingHash) {
				serverCursor = Math.max(serverCursor, existingHash.serverCursor);
				continue;
			}
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
				.filter(
					(row) =>
						row.docId === args.docId && row.serverCursor > args.sinceCursor,
				)
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

	async waitForDocRows(docId: string, count: number): Promise<void> {
		await waitFor(() => this.rows.filter((row) => row.docId === docId).length >= count);
	}

	private notify(): void {
		for (const client of this.clients) {
			client.notifySubscribers();
		}
	}
}

class FakeConvexClient {
	private dropped = false;
	private killed = false;
	private hasEverConnected = true;
	private readonly subscribers = new Set<Subscriber>();
	private readonly queuedMutations: Array<() => void> = [];
	private readonly connectionListeners = new Set<(state: FakeConnectionState) => void>();

	constructor(private readonly server: SharedAutomergeServer) {
		server.register(this);
	}

	connectionState(): FakeConnectionState {
		return {
			isWebSocketConnected: !this.dropped && !this.killed,
			hasEverConnected: this.hasEverConnected,
			hasInflightRequests: false,
			timeOfOldestInflightRequest: null,
			connectionCount: this.hasEverConnected ? 1 : 0,
			connectionRetries: this.dropped ? 1 : 0,
			inflightMutations: this.queuedMutations.length,
		};
	}

	subscribeToConnectionState(
		callback: (state: FakeConnectionState) => void,
	): () => void {
		this.connectionListeners.add(callback);
		return () => this.connectionListeners.delete(callback);
	}

	onUpdate(
		_query: unknown,
		args: PullChangesArgs | LatestCursorArgs,
		callback: (result: PullResult | number) => unknown,
	): FakeUnsubscribe {
		const subscriber = { args, callback };
		this.subscribers.add(subscriber);
		queueMicrotask(() => this.notifySubscriber(subscriber));
		const unsubscribe = (() => {
			this.subscribers.delete(subscriber);
		}) as FakeUnsubscribe;
		unsubscribe.unsubscribe = unsubscribe;
		unsubscribe.getCurrentValue = () => this.getSubscriptionValue(args);
		return unsubscribe;
	}

	async mutation(_mutation: unknown, args: SubmitChangesArgs): Promise<unknown> {
		if (this.killed) {
			throw new Error("client killed");
		}
		if (this.dropped) {
			return new Promise((resolve, reject) => {
				this.queuedMutations.push(() => {
					this.runMutation(args).then(resolve).catch(reject);
				});
			});
		}
		return this.runMutation(args);
	}

	async query(_query: unknown, args: PullChangesArgs): Promise<PullResult> {
		if (this.dropped || this.killed) {
			throw new Error("network offline");
		}
		return this.server.pull(args);
	}

	drop(): void {
		this.dropped = true;
		this.emitConnectionState();
	}

	restore(): void {
		this.dropped = false;
		this.hasEverConnected = true;
		const queued = this.queuedMutations.splice(0);
		for (const run of queued) {
			run();
		}
		this.emitConnectionState();
		this.notifySubscribers();
	}

	kill(): void {
		this.killed = true;
		this.queuedMutations.length = 0;
		this.subscribers.clear();
		this.server.unregister(this);
		this.emitConnectionState();
	}

	notifySubscribers(): void {
		if (this.dropped || this.killed) {
			return;
		}
		for (const subscriber of this.subscribers) {
			this.notifySubscriber(subscriber);
		}
	}

	private notifySubscriber(subscriber: Subscriber): void {
		if (this.dropped || this.killed) {
			return;
		}
		subscriber.callback(this.getSubscriptionValue(subscriber.args));
	}

	private getSubscriptionValue(args: PullChangesArgs | LatestCursorArgs): PullResult | number {
		if ("sinceCursor" in args) {
			return this.server.pull(args);
		}
		return this.server.getLatestCursor(args);
	}

	private emitConnectionState(): void {
		for (const listener of this.connectionListeners) {
			listener(this.connectionState());
		}
	}

	private async runMutation(args: SubmitChangesArgs | PathMappingArgs): Promise<unknown> {
		if ("candidateDocId" in args) {
			return this.server.getOrCreateDocIdForPath(args);
		}
		return this.server.submit(args);
	}
}

async function writeCharacters(
	doc: OpenDocumentSession,
	text: string,
): Promise<string> {
	let expected = doc.getTextSnapshot();
	for (const char of text) {
		await doc.applyLocalChange([{ pos: expected.length, del: 0, ins: char }]);
		expected += char;
	}
	return expected;
}

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const startedAt = performance.now();
	while (!predicate()) {
		if (performance.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
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

type FakeConnectionState = {
	isWebSocketConnected: boolean;
	hasEverConnected: boolean;
	hasInflightRequests: boolean;
	timeOfOldestInflightRequest: null;
	connectionCount: number;
	connectionRetries: number;
	inflightMutations: number;
};
