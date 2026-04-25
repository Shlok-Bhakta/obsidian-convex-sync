import { ConvexClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
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
		let latestCursor = 0;
		const seen = new Set<string>();
		const unsubscribe = this.options.client.onUpdate(
			api.automergeSync.pullChanges,
			{
				convexSecret: this.options.convexSecret,
				docId,
				sinceCursor: 0,
				numItems: 100,
			},
			(result) => {
				const changes = result.page
					.filter((change) => !seen.has(change.hash))
					.map((change) => {
						seen.add(change.hash);
						latestCursor = Math.max(latestCursor, change.serverCursor);
						return {
							hash: change.hash,
							type: change.type,
							data: new Uint8Array(change.data),
							serverCursor: change.serverCursor,
							clientId: change.clientId,
						};
					});
				if (changes.length > 0) {
					onChanges(changes);
				}
			},
		);

		return () => {
			void latestCursor;
			unsubscribe();
		};
	}

	async pushChanges(docId: string, changes: Uint8Array[]): Promise<number> {
		if (changes.length === 0) {
			return 0;
		}
		const idempotencyKey = await derivePushIdempotencyKey(
			this.options.clientId,
			docId,
			changes,
		);

		console.info("[transport] push sent", {
			docId,
			changeCount: changes.length,
			idempotencyKeyPrefix: idempotencyKey.slice(0, 8),
		});

		const result = await retry(
			() =>
				this.options.client.mutation(api.automergeSync.submitChanges, {
					convexSecret: this.options.convexSecret,
					docId,
					clientId: this.options.clientId,
					idempotencyKey,
					changes: changes.map((change) => ({
						type: "incremental" as const,
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
				numItems: 100,
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

	getConnectionState(): ConnectionStatus {
		return this.connectionStatus;
	}

	dispose(): void {
		this.unsubscribeConnection();
	}
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
	return !/\b(400|401|403|404)\b/.test(message);
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
	) as ArrayBuffer;
}
