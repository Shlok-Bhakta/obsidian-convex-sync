import type { FunctionReference } from "convex/server";
import type { ConvexClient } from "convex/browser";
import type { Awareness } from "y-protocols/awareness.js";
import {
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
} from "y-protocols/awareness.js";
import type { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

type YjsAwarenessApi = typeof api.yjsAwareness;

type AwarenessUpdateRow = {
	_id: Id<"yjsAwarenessUpdates">;
	update: ArrayBuffer;
};

const PUSH_DEBOUNCE_MS = 40;
const REMOTE_ORIGIN = "convex-awareness-sync";

export class ConvexAwarenessSync {
	private readonly appliedRowIds = new Set<string>();
	private unsubscribe: (() => void) | null = null;
	private destroyed = false;
	private pushTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly onAwarenessUpdate = (
		_event: { added: number[]; updated: number[]; removed: number[] },
		origin?: unknown,
	): void => {
		if (this.destroyed || origin === REMOTE_ORIGIN) return;
		this.schedulePush();
	};

	constructor(
		private readonly client: ConvexClient,
		private readonly docId: string,
		private readonly awareness: Awareness,
		private readonly convexApi: YjsAwarenessApi,
		private readonly convexSecret: string,
	) {
		this.awareness.on("update", this.onAwarenessUpdate);
		this.unsubscribe = this.client.onUpdate(
			this.convexApi.listAwarenessUpdates as FunctionReference<"query">,
			{ docId: this.docId, convexSecret: this.convexSecret },
			(rawRows) => {
				if (this.destroyed) return;
				const rows = rawRows as AwarenessUpdateRow[];
				for (const row of rows) {
					if (this.appliedRowIds.has(row._id)) continue;
					this.appliedRowIds.add(row._id);
					const u8 = new Uint8Array(row.update);
					try {
						applyAwarenessUpdate(this.awareness, u8, REMOTE_ORIGIN);
					} catch (e) {
						console.warn("[ConvexAwarenessSync] skipped invalid awareness update", e);
					}
				}
			},
			(err: Error) => {
				console.error("Convex Yjs awareness subscription failed", err);
			},
		);
	}

	private schedulePush(): void {
		if (this.pushTimer !== null) {
			clearTimeout(this.pushTimer);
		}
		this.pushTimer = setTimeout(() => {
			this.pushTimer = null;
			this.pushLocalStateNow();
		}, PUSH_DEBOUNCE_MS);
	}

	private pushLocalStateNow(): void {
		if (this.destroyed) return;
		const localId = this.awareness.clientID;
		try {
			const update = encodeAwarenessUpdate(this.awareness, [localId]);
			if (update.byteLength === 0) return;
			void this.client
				.mutation(this.convexApi.pushAwarenessUpdate as FunctionReference<"mutation">, {
					docId: this.docId,
					convexSecret: this.convexSecret,
					update: toArrayBuffer(update),
				})
				.catch((e: unknown) => {
					console.error("Convex Yjs awareness push failed", e);
				});
		} catch (e) {
			console.error("Convex Yjs awareness encode failed", e);
		}
	}

	flush(): void {
		if (this.pushTimer !== null) {
			clearTimeout(this.pushTimer);
			this.pushTimer = null;
		}
		this.pushLocalStateNow();
	}

	destroy(): void {
		if (this.destroyed) return;
		this.destroyed = true;
		if (this.pushTimer !== null) {
			clearTimeout(this.pushTimer);
			this.pushTimer = null;
		}
		this.awareness.off("update", this.onAwarenessUpdate);
		this.unsubscribe?.();
		this.unsubscribe = null;
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
