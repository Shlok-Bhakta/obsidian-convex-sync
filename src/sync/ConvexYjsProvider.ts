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
		void this.client
			.mutation(this.convexApi.push as FunctionReference<"mutation">, {
				docId: this.docId,
				update: toArrayBuffer(update),
			})
			.catch((error: unknown) => {
				console.error("Convex Yjs push failed", error);
			});
	};

	private unsubscribePull: (() => void) | null = null;
	private destroyed = false;

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
				stateVector: toArrayBuffer(Y.encodeStateVector(this.doc)),
			},
		);
		if (this.destroyed) return;

		Y.applyUpdate(this.doc, toUint8Array(initial.update), this.remoteOrigin);

		this.doc.on("update", this.onDocUpdate);
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

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		this.doc.off("update", this.onDocUpdate);
		this.unsubscribePull?.();
		this.unsubscribePull = null;
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
