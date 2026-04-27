import type { FunctionReference } from "convex/server";
import type { ConvexClient } from "convex/browser";
import type { api } from "../../convex/_generated/api";
import * as Y from "yjs";
import { normalizePath } from "obsidian";
import { sha256Utf8, textByteLength, toArrayBuffer } from "./text-sync-shared";

type ConvexSyncApi = typeof api;
type YjsInitAction = FunctionReference<
	"action",
	"public",
	{ convexSecret: string; docId: string; stateVector: ArrayBuffer },
	{ update: ArrayBuffer; serverStateVector: ArrayBuffer }
>;
type YjsPullAction = FunctionReference<
	"action",
	"public",
	{ convexSecret: string; docId: string },
	ArrayBuffer
>;
type TextFileStateQuery = FunctionReference<
	"query",
	"public",
	{ convexSecret: string; path: string },
	| null
	| {
			path: string;
			contentHash: string;
			sizeBytes: number;
			updatedAtMs: number;
			updatedByClientId: string;
	  }
>;

export class ConvexYjsProvider {
	private readonly remoteOrigin = { source: "convex-yjs-provider" };
	private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
		if (origin === this.remoteOrigin || this.destroyed) {
			return;
		}
		this.enqueuePush(update);
	};

	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingUpdate: Uint8Array | null = null;
	private pushInFlight = false;
	private pullInFlight = false;
	private pendingRemotePull = false;
	private retryDelayMs = 500;
	private destroyed = false;
	private syncStarted = false;
	private serverStateVector: Uint8Array | null = null;
	private metadataUnsub: (() => void) | null = null;
	private remoteStateInitialized = false;
	private static readonly PUSH_DEBOUNCE_MS = 200;
	private static readonly ACTION_RETRY_MAX_ATTEMPTS = 6;
	private static readonly ACTION_RETRY_BASE_DELAY_MS = 400;

	/** Optional hook when applying remote updates fails (e.g. corrupt payload). */
	onDivergence: (() => void) | null = null;

	constructor(
		private readonly client: ConvexClient,
		private readonly docId: string,
		private readonly path: string,
		private readonly doc: Y.Doc,
		private readonly convexApi: ConvexSyncApi,
		private readonly convexSecret: string,
		private readonly clientId: string,
	) {}

	async init(): Promise<void> {
		if (this.destroyed) return;
		const initial = await this.withConvexActionRetries("yjsSync:init", () =>
			this.client.action(this.convexApi.yjsSync.init as YjsInitAction, {
				convexSecret: this.convexSecret,
				docId: this.docId,
				// Always request the full server update relative to an *empty* Y.Doc state vector
				// (not encodeStateVector(this.doc) after idb load). Otherwise diffUpdate omits
				// server-side deletes the cache never saw. Never use Uint8Array(0): Y.diffUpdate
				// throws "Unexpected end of array" for zero-length state vectors.
				stateVector: toArrayBuffer(Y.encodeStateVector(new Y.Doc())),
			}),
		);
		if (this.destroyed) return;

		Y.applyUpdate(this.doc, toUint8Array(initial.update), this.remoteOrigin);
		this.serverStateVector = toUint8Array(initial.serverStateVector);
	}

	startSync(): void {
		if (this.destroyed || this.syncStarted) return;
		this.syncStarted = true;
		this.doc.on("update", this.onDocUpdate);
		this.startRemoteSubscription();
		// Push only local delta against last server vector instead of full state.
		const localDelta = this.serverStateVector
			? Y.encodeStateAsUpdate(this.doc, this.serverStateVector)
			: Y.encodeStateAsUpdate(this.doc);
		this.enqueuePush(localDelta);
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
		this.onDivergence = null;
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.doc.off("update", this.onDocUpdate);
		this.metadataUnsub?.();
		this.metadataUnsub = null;
	}

	async flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.retryTimer) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		await this.flushPushQueue();
	}

	private enqueuePush(update: Uint8Array): void {
		if (update.byteLength === 0 || this.destroyed) return;
		this.pendingUpdate = this.pendingUpdate
			? Y.mergeUpdates([this.pendingUpdate, update])
			: update;
		if (this.flushTimer) {
			return;
		}
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flushPushQueue();
		}, ConvexYjsProvider.PUSH_DEBOUNCE_MS);
	}

	private async flushPushQueue(): Promise<void> {
		if (this.destroyed || this.pushInFlight || !this.pendingUpdate) return;
		const nextUpdate = this.pendingUpdate;
		this.pendingUpdate = null;
		this.pushInFlight = true;
		try {
			const content = this.doc.getText("content").toString();
			await this.client.mutation(this.convexApi.yjsSync.push as FunctionReference<"mutation">, {
				convexSecret: this.convexSecret,
				docId: this.docId,
				path: this.path,
				update: toArrayBuffer(nextUpdate),
				contentHash: await sha256Utf8(content),
				sizeBytes: textByteLength(content),
				updatedAtMs: Date.now(),
				clientId: this.clientId,
			});
			this.serverStateVector = Y.encodeStateVector(this.doc);
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

	private startRemoteSubscription(): void {
		if (this.metadataUnsub || this.destroyed) {
			return;
		}
		this.metadataUnsub = this.client.onUpdate(
			this.convexApi.fileSync.getTextFileState as TextFileStateQuery,
			{
				convexSecret: this.convexSecret,
				path: normalizePath(this.path),
			},
			(state) => {
				if (this.destroyed || !this.syncStarted) {
					return;
				}
				if (!this.remoteStateInitialized) {
					this.remoteStateInitialized = true;
					return;
				}
				if (!state || state.updatedByClientId === this.clientId) {
					return;
				}
				this.pendingRemotePull = true;
				if (!this.pullInFlight) {
					void this.pullServerState();
				}
			},
			(err: Error) => {
				console.error("Convex Yjs metadata subscription failed", err);
			},
		);
	}

	private async pullServerState(): Promise<void> {
		if (this.destroyed || this.pullInFlight || !this.pendingRemotePull) return;
		this.pullInFlight = true;
		this.pendingRemotePull = false;
		try {
			const serverUpdate = await this.withConvexActionRetries("yjsSync:pull", () =>
				this.client.action(this.convexApi.yjsSync.pull as YjsPullAction, {
					convexSecret: this.convexSecret,
					docId: this.docId,
				}),
			);
			if (this.destroyed) return;
			const mergedRemote = toUint8Array(serverUpdate);
			// Apply only the missing prefix of the server merge relative to the local
			// doc to avoid replaying full-state updates on every poll.
			const delta = Y.diffUpdate(mergedRemote, Y.encodeStateVector(this.doc));
			if (delta.byteLength > 0) {
				Y.applyUpdate(this.doc, delta, this.remoteOrigin);
			}
			this.serverStateVector = Y.encodeStateVectorFromUpdate(mergedRemote);
		} catch (err: unknown) {
			if (ConvexYjsProvider.isTransientConvexClientError(err)) {
				console.warn("[ConvexYjsProvider] pull action failed (transient); will retry on next poll", err);
			} else {
				console.error("[ConvexYjsProvider] pull action failed — re-sync suggested", err);
				this.onDivergence?.();
			}
		} finally {
			this.pullInFlight = false;
			if (this.pendingRemotePull) {
				void this.pullServerState();
			}
		}
	}

	private async withConvexActionRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
		let attempt = 0;
		while (true) {
			if (this.destroyed) {
				throw new Error(`[CONVEX A(${label})] provider destroyed`);
			}
			attempt++;
			try {
				return await fn();
			} catch (e: unknown) {
				if (this.destroyed) throw e;
				const retriable =
					ConvexYjsProvider.isTransientConvexClientError(e) &&
					attempt < ConvexYjsProvider.ACTION_RETRY_MAX_ATTEMPTS;
				if (!retriable) throw e;
				const delay = Math.min(
					ConvexYjsProvider.ACTION_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
					10_000,
				);
				console.warn(`[ConvexYjsProvider] ${label} failed (attempt ${attempt}); retrying in ${delay}ms`, e);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}

	private static isTransientConvexClientError(error: unknown): boolean {
		const msg =
			error instanceof Error
				? error.message
				: typeof error === "string"
					? error
					: "";
		return (
			msg.includes("Connection lost") ||
			msg.includes("connection lost") ||
			msg.includes("Failed to fetch") ||
			msg.includes("NetworkError") ||
			msg.includes("Load failed") ||
			msg.includes("The operation was aborted") ||
			msg.includes("Network request failed")
		);
	}
}

function toUint8Array(bytes: ArrayBuffer | Uint8Array): Uint8Array {
	return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}
