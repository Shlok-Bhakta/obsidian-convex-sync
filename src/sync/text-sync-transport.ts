import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import * as Y from "yjs";
import type { api } from "../../convex/_generated/api";
import {
	createTextYDoc,
	sha256Utf8,
	textByteLength,
	textDocIdForPath,
	toArrayBuffer,
} from "./text-sync-shared";

type TextSyncTransport = Pick<ConvexClient, "action" | "mutation"> | Pick<ConvexHttpClient, "action" | "mutation">;

type TextSyncApi = typeof api;

type PushSnapshotOptions = {
	client: TextSyncTransport;
	convexApi: TextSyncApi;
	convexSecret: string;
	clientId: string;
	vaultName: string;
	path: string;
	doc: Y.Doc;
	updatedAtMs?: number;
};

type ReadRemoteTextOptions = {
	client: TextSyncTransport;
	convexApi: TextSyncApi;
	convexSecret: string;
	vaultName: string;
	path: string;
};

export async function pushTextDocumentSnapshot({
	client,
	convexApi,
	convexSecret,
	clientId,
	vaultName,
	path,
	doc,
	updatedAtMs = Date.now(),
}: PushSnapshotOptions): Promise<void> {
	const content = doc.getText("content").toString();
	const contentHash = await sha256Utf8(content);
	await client.mutation(convexApi.yjsSync.push as FunctionReference<"mutation">, {
		convexSecret,
		docId: textDocIdForPath(vaultName, path),
		path,
		update: toArrayBuffer(Y.encodeStateAsUpdate(doc)),
		contentHash,
		sizeBytes: textByteLength(content),
		updatedAtMs,
		clientId,
	});
}

export async function pushTextContentSnapshot(options: Omit<PushSnapshotOptions, "doc"> & {
	content: string;
}): Promise<Y.Doc> {
	const doc = createTextYDoc(options.content);
	try {
		await pushTextDocumentSnapshot({ ...options, doc });
		return doc;
	} catch (error) {
		doc.destroy();
		throw error;
	}
}

export async function readRemoteTextContent({
	client,
	convexApi,
	convexSecret,
	vaultName,
	path,
}: ReadRemoteTextOptions): Promise<string> {
	const doc = new Y.Doc();
	const emptyDoc = new Y.Doc();
	try {
		const initial = await client.action(
			convexApi.yjsSync.init as FunctionReference<"action">,
			{
				convexSecret,
				docId: textDocIdForPath(vaultName, path),
				stateVector: toArrayBuffer(Y.encodeStateVector(emptyDoc)),
			},
		);
		const update = new Uint8Array(initial.update);
		if (update.byteLength > 0) {
			Y.applyUpdate(doc, update);
		}
		return doc.getText("content").toString();
	} finally {
		emptyDoc.destroy();
		doc.destroy();
	}
}
