import type { FunctionReference } from "convex/server";
import type { ConvexClient } from "convex/browser";
import type { api } from "../../convex/_generated/api";
import * as Y from "yjs";

type YjsApi = typeof api.yjs;

export class ConvexYjsProvider {
	private readonly remoteOrigin = { source: "convex-yjs-provider" };
	private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
		if (origin === this.remoteOrigin || this.destroyed) {
			return;
		}
		this.enqueuePush(update);
	};

	private unsubscribePull: (() => void) | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingUpdate: Uint8Array | null = null;
	private pushInFlight = false;
	private retryDelayMs = 500;
	private destroyed = false;
	private syncStarted = false;

	constructor(
		private readonly client: ConvexClient,
		private readonly docId: string,
		private readonly doc: Y.Doc,
		private readonly convexApi: YjsApi,
	) {}

	async init(): Promise<void> {
		if (this.destroyed) return;
		const initial = await this.client.action(
			this.convexApi.init as FunctionReference<"action">,
			{
				docId: this.docId,
				// Always request the full server update relative to an *empty* Y.Doc state vector
				// (not encodeStateVector(this.doc) after idb load). Otherwise diffUpdate omits
				// server-side deletes the cache never saw. Never use Uint8Array(0): Y.diffUpdate
				// throws "Unexpected end of array" for zero-length state vectors.
				stateVector: toArrayBuffer(Y.encodeStateVector(new Y.Doc())),
			},
		);
		if (this.destroyed) return;

		Y.applyUpdate(this.doc, toUint8Array(initial.update), this.remoteOrigin);
	}

	startSync(): void {
		if (this.destroyed || this.syncStarted) return;
		this.syncStarted = true;
		this.doc.on("update", this.onDocUpdate);
		// Proactively push the current doc state so locally cached edits are not stuck
		// waiting for a brand-new keystroke after reconnect/reopen.
		this.enqueuePush(Y.encodeStateAsUpdate(this.doc));
		this.unsubscribePull = this.client.onUpdate(
			this.convexApi.pull as FunctionReference<"query">,
			{ docId: this.docId },
			(serverUpdate) => {
				if (this.destroyed) return;
				Y.applyUpdate(this.doc, toUint8Array(serverUpdate), this.remoteOrigin);
			},
			(error: Error) => {
				console.error("Convex Yjs pull subscription failed", error);
			},
		);
	}

	/** Push the entire CRDT state (e.g. after rename when docId changes server-side). */
	async pushFullState(): Promise<void> {
		if (this.destroyed) return;
		const update = Y.encodeStateAsUpdate(this.doc);
		if (update.byteLength === 0) return;
		this.enqueuePush(update);
		await this.flushPushQueue();
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.syncStarted = false;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		this.doc.off("update", this.onDocUpdate);
		this.unsubscribePull?.();
		this.unsubscribePull = null;
	}

	private enqueuePush(update: Uint8Array): void {
		if (update.byteLength === 0 || this.destroyed) return;
		this.pendingUpdate = this.pendingUpdate
			? Y.mergeUpdates([this.pendingUpdate, update])
			: update;
		void this.flushPushQueue();
	}

	private async flushPushQueue(): Promise<void> {
		if (this.destroyed || this.pushInFlight || !this.pendingUpdate) return;
		const nextUpdate = this.pendingUpdate;
		this.pendingUpdate = null;
		this.pushInFlight = true;
		try {
			await this.client.mutation(this.convexApi.push as FunctionReference<"mutation">, {
				docId: this.docId,
				update: toArrayBuffer(nextUpdate),
			});
			this.retryDelayMs = 500;
		} catch (error: unknown) {
			console.error("Convex Yjs push failed", error);
			this.pendingUpdate = this.pendingUpdate
				? Y.mergeUpdates([nextUpdate, this.pendingUpdate])
				: nextUpdate;
			this.scheduleRetry();
		} finally {
			this.pushInFlight = false;
		}
		if (this.pendingUpdate && !this.retryTimer) {
			void this.flushPushQueue();
		}
	}

	private scheduleRetry(): void {
		if (this.retryTimer || this.destroyed) return;
		const delay = this.retryDelayMs;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			void this.flushPushQueue();
		}, delay);
		this.retryDelayMs = Math.min(this.retryDelayMs * 2, 10_000);
	}
}

function toUint8Array(bytes: ArrayBuffer | Uint8Array): Uint8Array {
	return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}
