import { createStore, del, get, set } from "idb-keyval";
import * as Y from "yjs";

/** Same DB/store as binary sync cursor/hash keys (`binary-sync-manager.ts`). */
export const obsidianConvexIdbStore = createStore("obsidian-yjs-v1", "docs");

export const YjsLocalCache = {
	async load(docId: string, doc: Y.Doc): Promise<void> {
		const state = await get<Uint8Array>(docId, obsidianConvexIdbStore);
		if (state) {
			Y.applyUpdate(doc, state);
		}
	},
	async save(docId: string, doc: Y.Doc): Promise<void> {
		await set(docId, Y.encodeStateAsUpdate(doc), obsidianConvexIdbStore);
	},
	async remove(docId: string): Promise<void> {
		await del(docId, obsidianConvexIdbStore);
	},
	/** True if IndexedDB has a non-empty persisted Yjs update for this doc. */
	async hasCachedState(docId: string): Promise<boolean> {
		const state = await get<Uint8Array>(docId, obsidianConvexIdbStore);
		return state != null && state.byteLength > 0;
	},
};
