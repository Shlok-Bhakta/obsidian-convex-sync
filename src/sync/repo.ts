// Obsidian's esbuild config does not enable async wasm imports, so we force Automerge's base64 entrypoint.
// @ts-expect-error This private path is intentional for bundling compatibility.
import * as Automerge from "../../node_modules/@automerge/automerge/dist/mjs/entrypoints/fullfat_base64.js";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { Platform } from "obsidian";
import {
	base64ToBytes,
	bytesToBase64,
	toUint8Array,
} from "./shared";

type TextDoc = { text: string };

export type PendingTextOp = {
	clientSeq: number;
	timestampMs: number;
	changeBytesBase64: string;
};

type StoredTextMeta = {
	path: string;
	clientSeq: number;
	lastSyncedServerSeq: number;
	pendingOps: PendingTextOp[];
};

export type RemoteTextOp = {
	seq: number;
	clientId: string;
	clientSeq: number;
	changeBytes: ArrayBuffer | Uint8Array;
	timestampMs: number;
};

type TextState = {
	doc: Automerge.Doc<TextDoc>;
	meta: StoredTextMeta;
};

const DOC_PREFIX = ["obsidian-convex-sync", "docs"];
const META_PREFIX = ["obsidian-convex-sync", "meta"];

function emptyDoc(): Automerge.Doc<TextDoc> {
	return Automerge.from<TextDoc>({ text: "" });
}

function emptyMeta(path: string): StoredTextMeta {
	return {
		path,
		clientSeq: 0,
		lastSyncedServerSeq: 0,
		pendingOps: [],
	};
}

export async function probeLiveSyncSupport(): Promise<boolean> {
	if (typeof indexedDB === "undefined") {
		return false;
	}
	try {
		const adapter = new IndexedDBStorageAdapter(
			"obsidian-convex-sync-probe",
			"documents",
		);
		const doc = Automerge.from<TextDoc>({ text: "probe" });
		const bytes = Automerge.save(doc);
		await adapter.save(["probe"], bytes);
		await adapter.remove(["probe"]);
		return true;
	} catch (error) {
		console.warn("Live sync capability probe failed", error, {
			platform: Platform.isMobileApp ? "mobile" : "desktop",
		});
		return false;
	}
}

export class LiveSyncRepo {
	private readonly storage = new IndexedDBStorageAdapter(
		"obsidian-convex-sync",
		"live-sync",
	);

	private readonly docs = new Map<string, Automerge.Doc<TextDoc>>();
	private readonly meta = new Map<string, StoredTextMeta>();

	async load(docId: string, path: string): Promise<TextState> {
		const cachedDoc = this.docs.get(docId);
		const cachedMeta = this.meta.get(docId);
		if (cachedDoc && cachedMeta) {
			if (path && cachedMeta.path !== path) {
				cachedMeta.path = path;
				await this.saveMeta(docId, cachedMeta);
			}
			return { doc: cachedDoc, meta: cachedMeta };
		}
		const [docBytes, metaBytes] = await Promise.all([
			this.storage.load([...DOC_PREFIX, docId]),
			this.storage.load([...META_PREFIX, docId]),
		]);
		const doc = docBytes ? Automerge.load<TextDoc>(docBytes) : emptyDoc();
		const meta = metaBytes
			? ({
					...emptyMeta(path),
					...JSON.parse(new TextDecoder().decode(metaBytes)),
				} as StoredTextMeta)
			: emptyMeta(path);
		if (path) {
			meta.path = path;
		}
		this.docs.set(docId, doc);
		this.meta.set(docId, meta);
		await this.save(docId, doc, meta);
		return { doc, meta };
	}

	async getText(docId: string, path: string): Promise<string> {
		return (await this.load(docId, path)).doc.text ?? "";
	}

	async applyLocalText(
		docId: string,
		path: string,
		text: string,
	): Promise<{ changed: boolean; clientSeq: number | null }> {
		const state = await this.load(docId, path);
		if ((state.doc.text ?? "") === text) {
			return { changed: false, clientSeq: null };
		}
		const nextDoc = Automerge.change(state.doc, (draft: any) => {
			Automerge.updateText(draft, ["text"], text);
		});
		const lastChange = Automerge.getLastLocalChange(nextDoc);
		if (!lastChange) {
			await this.save(docId, nextDoc, state.meta);
			return { changed: false, clientSeq: null };
		}
		const nextMeta: StoredTextMeta = {
			...state.meta,
			path,
			clientSeq: state.meta.clientSeq + 1,
			pendingOps: [
				...state.meta.pendingOps,
				{
					clientSeq: state.meta.clientSeq + 1,
					timestampMs: Date.now(),
					changeBytesBase64: bytesToBase64(lastChange),
				},
			],
		};
		await this.save(docId, nextDoc, nextMeta);
		return { changed: true, clientSeq: nextMeta.clientSeq };
	}

	async mergeRemoteText(
		docId: string,
		path: string,
		payload: {
			snapshotBytes: Uint8Array | null;
			snapshotSeq: number;
			ops: RemoteTextOp[];
		},
		localClientId: string,
	): Promise<string> {
		const state = await this.load(docId, path);
		let baseDoc = state.doc;
		if (payload.snapshotBytes) {
			baseDoc = Automerge.load<TextDoc>(payload.snapshotBytes);
		}
		const remoteChanges = payload.ops.map((op) => toUint8Array(op.changeBytes));
		if (remoteChanges.length > 0) {
			baseDoc = Automerge.applyChanges(baseDoc, remoteChanges)[0];
		}
		if (payload.snapshotBytes && state.meta.pendingOps.length > 0) {
			baseDoc = Automerge.applyChanges(
				baseDoc,
				state.meta.pendingOps.map((op) => base64ToBytes(op.changeBytesBase64)),
			)[0];
		}
		const ackedClientSeqs = new Set(
			payload.ops
				.filter((op) => op.clientId === localClientId)
				.map((op) => op.clientSeq),
		);
		const highestSeq = payload.ops.reduce(
			(max, op) => Math.max(max, op.seq),
			Math.max(state.meta.lastSyncedServerSeq, payload.snapshotSeq),
		);
		const nextMeta: StoredTextMeta = {
			...state.meta,
			path,
			lastSyncedServerSeq: highestSeq,
			pendingOps: state.meta.pendingOps.filter(
				(op) => !ackedClientSeqs.has(op.clientSeq),
			),
		};
		await this.save(docId, baseDoc, nextMeta);
		return baseDoc.text ?? "";
	}

	async pendingOps(docId: string, path: string): Promise<PendingTextOp[]> {
		return [...(await this.load(docId, path)).meta.pendingOps];
	}

	async lastSyncedSeq(docId: string, path: string): Promise<number> {
		return (await this.load(docId, path)).meta.lastSyncedServerSeq;
	}

	async ackPending(docId: string, path: string, clientSeqs: number[], serverSeqs: number[]) {
		const state = await this.load(docId, path);
		const nextMeta: StoredTextMeta = {
			...state.meta,
			lastSyncedServerSeq: Math.max(
				state.meta.lastSyncedServerSeq,
				...serverSeqs,
			),
			pendingOps: state.meta.pendingOps.filter(
				(op) => !clientSeqs.includes(op.clientSeq),
			),
		};
		await this.save(docId, state.doc, nextMeta);
	}

	async exportSnapshot(docId: string, path: string): Promise<Uint8Array> {
		const state = await this.load(docId, path);
		return Automerge.save(state.doc);
	}

	private async save(docId: string, doc: Automerge.Doc<TextDoc>, meta: StoredTextMeta) {
		this.docs.set(docId, doc);
		this.meta.set(docId, meta);
		await Promise.all([
			this.storage.save([...DOC_PREFIX, docId], Automerge.save(doc)),
			this.saveMeta(docId, meta),
		]);
	}

	private async saveMeta(docId: string, meta: StoredTextMeta) {
		await this.storage.save(
			[...META_PREFIX, docId],
			new TextEncoder().encode(JSON.stringify(meta)),
		);
	}
}
