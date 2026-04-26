import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import {
	MAX_AUTOMERGE_MUTATION_BYTES,
	MAX_AUTOMERGE_PAYLOAD_BYTES,
} from "../core/limits";
import { retry } from "./retry";

export type ConnectionStatus = "connected" | "reconnecting" | "offline";

export type ConvexAutomergeTransportOptions = {
	client: ConvexClient;
	convexSecret: string;
	clientId: string;
};

export type PulledAutomergeChange = {
	hash: string;
	data: Uint8Array;
	type: "incremental" | "snapshot";
	serverCursor: number;
	clientId: string;
};

export type DocPathChange = {
	path: string;
	docId: string;
	updatedAtMs: number;
	updatedByClientId: string;
	deletedAtMs: number | null;
};

export class ConvexAutomergeTransport {
	private connectionStatus: ConnectionStatus = "offline";
	private readonly unsubscribeConnection: () => void;

	constructor(private readonly options: ConvexAutomergeTransportOptions) {
		this.connectionStatus = mapConnectionState(options.client.connectionState());
		this.unsubscribeConnection = options.client.subscribeToConnectionState((state) => {
			const previous = this.connectionStatus;
			this.connectionStatus = mapConnectionState(state);
			if (previous !== this.connectionStatus) {
				console.info("[transport] connection state change", {
					oldState: previous,
					newState: this.connectionStatus,
				});
			}
		});
	}

	watchDoc(
		docId: string,
		onChanges: (changes: PulledAutomergeChange[]) => void,
	): () => void {
		let pulledThroughCursor = 0;
		let pullQueue = Promise.resolve();
		const seen = new Set<string>();
		const unsubscribe = this.options.client.onUpdate(
			api.automergeSync.getLatestCursor,
			{
				convexSecret: this.options.convexSecret,
				docId,
			},
			(latestCursor) => {
				if (latestCursor <= pulledThroughCursor) {
					return;
				}
				pullQueue = pullQueue
					.catch(() => undefined)
					.then(async () => {
						const changes = await this.pullMissingChanges(
							docId,
							pulledThroughCursor,
						);
						const unseen = changes.filter((change) => {
							const identity = changeIdentity(change.type, change.hash);
							if (seen.has(identity)) {
								return false;
							}
							seen.add(identity);
							return true;
						});
						for (const change of unseen) {
							pulledThroughCursor = Math.max(
								pulledThroughCursor,
								change.serverCursor,
							);
						}
						const deliverable = unseen.filter(
							(change) => change.clientId !== this.options.clientId,
						);
						if (deliverable.length > 0) {
							onChanges(deliverable);
						}
					})
					.catch((error: unknown) => {
						console.warn("[transport] watch pull failed", {
							docId,
							message: error instanceof Error ? error.message : String(error),
						});
					});
			},
		);

		return () => {
			unsubscribe();
		};
	}
	async pushChanges(docId: string, changes: Uint8Array[]): Promise<number> {
		if (changes.length === 0) {
			return 0;
		}
		assertAutomergePayloadsFit(changes);
		let latestServerCursor = 0;
		for (const batch of batchAutomergeChanges(changes)) {
			latestServerCursor = Math.max(
				latestServerCursor,
				await this.pushChangeBatch(docId, batch, "incremental"),
			);
		}
		return latestServerCursor;
	}

	private async pushChangeBatch(
		docId: string,
		changes: Uint8Array[],
		type: "incremental" | "snapshot",
	): Promise<number> {
		const idempotencyKey = await derivePushIdempotencyKey(
			this.options.clientId,
			docId,
			changes,
		);

		console.info("[transport] push sent", {
			docId,
			changeCount: changes.length,
			idempotencyKeyPrefix: idempotencyKey.slice(0, 8),
			type,
		});

		const result = await retry(
			() =>
				this.options.client.mutation(api.automergeSync.submitChanges, {
					convexSecret: this.options.convexSecret,
					docId,
					clientId: this.options.clientId,
					idempotencyKey,
					changes: changes.map((change) => ({
						type,
						data: toArrayBuffer(change),
					})),
				}),
			{
				maxAttempts: 4,
				shouldRetry: isRetryableTransportError,
			},
		);

		console.info("[transport] push ack", {
			docId,
			serverCursor: result.serverCursor,
		});
		return result.serverCursor;
	}

	async pushSnapshot(docId: string, snapshot: Uint8Array): Promise<number> {
		assertAutomergePayloadsFit([snapshot]);
		return this.pushChangeBatch(docId, [snapshot], "snapshot");
	}

	async pullMissingChanges(
		docId: string,
		sinceCursor: number,
	): Promise<PulledAutomergeChange[]> {
		const received: PulledAutomergeChange[] = [];
		let cursor: string | undefined;
		for (;;) {
			const page = await this.options.client.query(api.automergeSync.pullChanges, {
				convexSecret: this.options.convexSecret,
				docId,
				sinceCursor,
				numItems: 1,
				cursor,
			});
			for (const change of page.page) {
				received.push({
					hash: change.hash,
					type: change.type,
					data: new Uint8Array(change.data),
					serverCursor: change.serverCursor,
					clientId: change.clientId,
				});
			}
			if (page.isDone) {
				break;
			}
			cursor = page.continueCursor;
		}

		console.info("[transport] pull completed", {
			docId,
			changeCount: received.length,
		});
		return received;
	}

	async getOrCreateDocIdForPath(
		path: string,
		candidateDocId: string,
	): Promise<string> {
		const result = await this.options.client.mutation(
			api.automergeSync.getOrCreateDocIdForPath,
			{
				convexSecret: this.options.convexSecret,
				path,
				candidateDocId,
				clientId: this.options.clientId,
				updatedAtMs: Date.now(),
			},
		);
		return result.docId;
	}

	async deleteDocPath(path: string): Promise<void> {
		await this.options.client.mutation(api.automergeSync.deleteDocPath, {
			convexSecret: this.options.convexSecret,
			path,
			clientId: this.options.clientId,
			deletedAtMs: Date.now(),
		});
	}

	async renameDocPath(oldPath: string, newPath: string): Promise<void> {
		await this.options.client.mutation(api.automergeSync.renameDocPath, {
			convexSecret: this.options.convexSecret,
			oldPath,
			newPath,
			clientId: this.options.clientId,
			updatedAtMs: Date.now(),
		});
	}

	watchDocPathChanges(
		onChanges: (changes: DocPathChange[]) => void,
	): () => void {
		const seen = new Set<string>();
		const unsubscribe = this.options.client.onUpdate(
			api.automergeSync.listDocPathChanges,
			{
				convexSecret: this.options.convexSecret,
				sinceUpdatedAtMs: 0,
				numItems: 100,
			},
			(result) => {
				const changes = result.page.filter((change: DocPathChange) => {
					const identity = pathChangeIdentity(change);
					if (seen.has(identity)) {
						return false;
					}
					seen.add(identity);
					return true;
				});
				if (changes.length > 0) {
					onChanges(changes);
				}
			},
		);
		return () => unsubscribe();
	}

	async listDocPathChanges(sinceUpdatedAtMs = 0): Promise<DocPathChange[]> {
		const received: DocPathChange[] = [];
		let cursor: string | undefined;
		for (;;) {
			const result = await this.options.client.query(
				api.automergeSync.listDocPathChanges,
				{
					convexSecret: this.options.convexSecret,
					sinceUpdatedAtMs,
					numItems: 100,
					cursor,
				},
			);
			received.push(...result.page);
			if (result.isDone) {
				break;
			}
			cursor = result.continueCursor;
		}
		return received;
	}

	getConnectionState(): ConnectionStatus {
		return this.connectionStatus;
	}

	dispose(): void {
		this.unsubscribeConnection();
	}
}

function changeIdentity(type: "incremental" | "snapshot", hash: string): string {
	return `${type}:${hash}`;
}

function pathChangeIdentity(change: DocPathChange): string {
	return [
		change.path,
		change.docId,
		change.updatedAtMs,
		change.updatedByClientId,
		change.deletedAtMs ?? "live",
	].join(":");
}

export async function derivePushIdempotencyKey(
	clientId: string,
	docId: string,
	changes: Uint8Array[],
): Promise<string> {
	const changeHash = await sha256Hex(concatBytes(changes));
	return sha256Hex(`${clientId}:${docId}:${changeHash}`);
}

function mapConnectionState(state: {
	isWebSocketConnected: boolean;
	hasEverConnected: boolean;
}): ConnectionStatus {
	if (state.isWebSocketConnected) {
		return "connected";
	}
	return state.hasEverConnected ? "reconnecting" : "offline";
}

function isRetryableTransportError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("Automerge") && message.includes("too large")) {
		return false;
	}
	return !/\b(400|401|403|404)\b/.test(message);
}

function assertAutomergePayloadsFit(changes: Uint8Array[]): void {
	for (const change of changes) {
		if (change.byteLength > MAX_AUTOMERGE_PAYLOAD_BYTES) {
			throw new Error(
				`Automerge payload is too large (${change.byteLength} bytes > ${MAX_AUTOMERGE_PAYLOAD_BYTES} bytes). Use storage sync for this file instead.`,
			);
		}
	}
}

function batchAutomergeChanges(changes: Uint8Array[]): Uint8Array[][] {
	const batches: Uint8Array[][] = [];
	let current: Uint8Array[] = [];
	let currentBytes = 0;
	for (const change of changes) {
		if (current.length > 0 && currentBytes + change.byteLength > MAX_AUTOMERGE_MUTATION_BYTES) {
			batches.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(change);
		currentBytes += change.byteLength;
	}
	if (current.length > 0) {
		batches.push(current);
	}
	return batches;
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return merged;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	);
}
