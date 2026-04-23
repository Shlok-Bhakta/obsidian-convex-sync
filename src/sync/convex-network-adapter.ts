import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { MyPluginSettings } from "../settings";
import type { LiveSyncRepo, RemoteTextOp } from "./repo";
import { toArrayBuffer } from "./shared";

const MAX_APPEND_OPS = 50;
const MAX_APPEND_BYTES = 200_000;

type IndexRow = {
	docId: string;
	kind: "text" | "binary" | "folder";
	path: string;
	createdAtMs: number;
	updatedAtMs: number;
	latestSeq: number;
	latestSnapshotSeq: number;
	deletedAtMs: number | null;
	binaryHead:
		| {
				contentHash: string;
				sizeBytes: number;
				updatedAtMs: number;
				url: string | null;
		  }
		| null;
};

type DocPayload = {
	doc: {
		docId: string;
		kind: "text" | "binary" | "folder";
		path: string;
		latestSeq: number;
		latestSnapshotSeq: number;
		deletedAtMs: number | null;
	};
	snapshot: { upToSeq: number; sizeBytes: number; url: string | null } | null;
	ops: RemoteTextOp[];
	binaryHead:
		| {
				contentHash: string;
				sizeBytes: number;
				updatedAtMs: number;
				url: string | null;
		  }
		| null;
} | null;

type DocHeadPayload = {
	doc: {
		docId: string;
		kind: "text" | "binary" | "folder";
		path: string;
		latestSeq: number;
		latestSnapshotSeq: number;
		deletedAtMs: number | null;
	};
} | null;

type Unsubscribable = {
	(): void;
	unsubscribe(): void;
	getCurrentValue(): unknown;
};

function estimatedBase64DecodedSize(base64: string): number {
	const trimmed = base64.trim();
	const padding =
		trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
	return Math.floor((trimmed.length * 3) / 4) - padding;
}

export type LiveSyncNetworkHost = {
	settings: MyPluginSettings;
	getConvexHttpClient(): ConvexHttpClient;
	getConvexRealtimeClient(): ConvexClient | null;
	getPresenceSessionId(): string;
	registerInterval(id: number): void;
};

export class ConvexNetworkAdapter {
	private readonly docSubscriptions = new Map<string, Unsubscribable>();
	private readonly docPaths = new Map<string, string>();
	private indexSubscription: Unsubscribable | null = null;
	private readonly flushTimers = new Map<string, number>();
	private readonly flushingDocs = new Set<string>();
	private readonly pullingDocs = new Set<string>();
	private readonly repullDocs = new Set<string>();

	constructor(
		private readonly host: LiveSyncNetworkHost,
		private readonly repo: LiveSyncRepo,
	) {}

	startIndexSubscription(onUpdate: (rows: IndexRow[]) => void): void {
		this.stopIndexSubscription();
		const client = this.host.getConvexRealtimeClient();
		if (!client) {
			return;
		}
		this.indexSubscription = client.onUpdate(
			api.sync.subscribeIndex,
			{
				convexSecret: this.host.settings.convexSecret,
				since: 0,
			},
			(payload) => {
				onUpdate((payload?.docs ?? []) as IndexRow[]);
			},
			(error) => {
				console.error("Live sync index subscription failed", error);
			},
		) as unknown as Unsubscribable;
		const initial = this.indexSubscription.getCurrentValue() as
			| { docs?: IndexRow[] }
			| undefined;
		if (initial?.docs) {
			onUpdate(initial.docs);
		}
	}

	ensureDocSubscription(
		docId: string,
		path: string,
		onUpdate: (payload: DocPayload) => void,
	): void {
		this.docPaths.set(docId, path);
		if (this.docSubscriptions.has(docId)) {
			return;
		}
		const client = this.host.getConvexRealtimeClient();
		if (!client) {
			return;
		}
		const sub = client.onUpdate(
			api.sync.subscribeDocHead,
			{
				convexSecret: this.host.settings.convexSecret,
				docId,
			},
			(payload) => {
				const currentPath = this.docPaths.get(docId) ?? path;
				void this.handleDocHead(
					docId,
					currentPath,
					(payload ?? null) as DocHeadPayload,
					onUpdate,
				);
			},
			(error) => {
				console.error(`Live sync doc subscription failed for ${docId}`, error);
			},
		) as unknown as Unsubscribable;
		this.docSubscriptions.set(docId, sub);
		const initial = sub.getCurrentValue() as DocHeadPayload | undefined;
		if (initial) {
			void this.handleDocHead(docId, path, initial, onUpdate);
		}
	}

	async createDoc(args: {
		docId: string;
		path: string;
		kind: "text" | "binary" | "folder";
	}): Promise<void> {
		await this.getMutationClient().mutation(api.sync.createDoc, {
			convexSecret: this.host.settings.convexSecret,
			clientId: this.host.getPresenceSessionId(),
			...args,
		});
	}

	scheduleFlush(docId: string, path: string): void {
		if (this.flushingDocs.has(docId) || this.flushTimers.has(docId)) {
			return;
		}
		const timer = window.setTimeout(() => {
			this.flushTimers.delete(docId);
			void this.flushDoc(docId, path);
		}, Math.max(10, this.host.settings.editorKeystrokeBatchMs));
		this.flushTimers.set(docId, timer);
		this.host.registerInterval(timer);
	}

	async flushDoc(docId: string, path: string): Promise<void> {
		if (this.flushingDocs.has(docId)) {
			return;
		}
		const pending = await this.repo.pendingOps(docId, path);
		if (pending.length === 0) {
			return;
		}
		this.flushingDocs.add(docId);
		try {
			const oversizedOp = pending.find(
				(op) => estimatedBase64DecodedSize(op.changeBytesBase64) > MAX_APPEND_BYTES,
			);
			if (oversizedOp) {
				await this.flushSnapshot(docId, path, pending);
				return;
			}
			const batch = [];
			let payloadBytes = 0;
			for (const op of pending) {
				if (batch.length >= MAX_APPEND_OPS) {
					break;
				}
				const opBytes = estimatedBase64DecodedSize(op.changeBytesBase64);
				if (batch.length > 0 && payloadBytes + opBytes > MAX_APPEND_BYTES) {
					break;
				}
				batch.push({
					clientSeq: op.clientSeq,
					changeBytesBase64: op.changeBytesBase64,
					timestampMs: op.timestampMs,
				});
				payloadBytes += opBytes;
			}
			if (batch.length === 0) {
				await this.flushSnapshot(docId, path, pending);
				return;
			}
			const result = await this.getMutationClient().mutation(api.sync.appendOps, {
				convexSecret: this.host.settings.convexSecret,
				docId,
				clientId: this.host.getPresenceSessionId(),
				ops: batch,
			});
			await this.repo.ackPending(
				docId,
				path,
				batch.map((op) => op.clientSeq),
				result.assignedSeqs,
			);
		} catch (error) {
			console.error(`Live sync flush failed for ${docId}`, error);
		} finally {
			this.flushingDocs.delete(docId);
			const remaining = await this.repo.pendingOps(docId, path);
			if (remaining.length > 0) {
				this.scheduleFlush(docId, path);
			}
		}
	}

	private async flushSnapshot(
		docId: string,
		path: string,
		pending: Array<{ clientSeq: number }>,
	): Promise<void> {
		const snapshot = await this.repo.exportSnapshot(docId, path);
		const storageId = await this.uploadBytes(
			toArrayBuffer(snapshot),
			"application/octet-stream",
		);
		const result = await this.getMutationClient().mutation(api.sync.replaceDocSnapshot, {
			convexSecret: this.host.settings.convexSecret,
			docId,
			clientId: this.host.getPresenceSessionId(),
			baseServerSeq: await this.repo.lastSyncedSeq(docId, path),
			clientSeqs: pending.map((op) => op.clientSeq),
			snapshotStorageId: storageId as never,
			snapshotSizeBytes: snapshot.byteLength,
		});
		await this.repo.ackPending(
			docId,
			path,
			pending.map((op) => op.clientSeq),
			result.assignedSeqs,
		);
	}

	async moveDoc(docId: string, newPath: string): Promise<void> {
		await this.getMutationClient().mutation(api.sync.moveDoc, {
			convexSecret: this.host.settings.convexSecret,
			docId,
			newPath,
			timestampMs: Date.now(),
			clientId: this.host.getPresenceSessionId(),
		});
	}

	async deleteDoc(docId: string, frozenStorageId?: string): Promise<void> {
		await this.getMutationClient().mutation(api.sync.deleteDoc, {
			convexSecret: this.host.settings.convexSecret,
			docId,
			frozenStorageId: frozenStorageId as never,
			timestampMs: Date.now(),
			clientId: this.host.getPresenceSessionId(),
			trashRetentionDays: this.host.settings.trashRetentionDays,
		});
	}

	async putBinaryVersion(args: {
		docId: string;
		storageId: string;
		contentHash: string;
		sizeBytes: number;
		updatedAtMs: number;
	}): Promise<void> {
		await this.getMutationClient().mutation(api.sync.putBinaryVersion, {
			convexSecret: this.host.settings.convexSecret,
			clientId: this.host.getPresenceSessionId(),
			retentionCount: this.host.settings.binaryVersionRetention,
			...args,
			storageId: args.storageId as never,
		});
	}

	async uploadBytes(bytes: ArrayBuffer, contentType: string): Promise<string> {
		const { uploadUrl } = await this.host.getConvexHttpClient().mutation(
			api.sync.issueUploadUrl,
			{ convexSecret: this.host.settings.convexSecret },
		);
		const blob = new Blob([bytes], { type: contentType });
		const response = await fetch(uploadUrl, {
			method: "POST",
			headers: { "Content-Type": contentType },
			body: blob,
		});
		if (!response.ok) {
			throw new Error(`Upload failed with HTTP ${response.status}`);
		}
		const payload = (await response.json()) as { storageId?: string };
		if (!payload.storageId) {
			throw new Error("Upload did not return a storageId.");
		}
		return payload.storageId;
	}

	async downloadBytes(url: string): Promise<ArrayBuffer> {
		const response = await fetch(url, { method: "GET", cache: "no-store" });
		if (!response.ok) {
			throw new Error(`Download failed with HTTP ${response.status}`);
		}
		return response.arrayBuffer();
	}

	async downloadLegacyText(path: string): Promise<string | null> {
		const signed = await this.host.getConvexHttpClient().query(api.fileSync.getDownloadUrl, {
			convexSecret: this.host.settings.convexSecret,
			path,
		});
		if (!signed?.url) {
			return null;
		}
		const bytes = await this.downloadBytes(signed.url);
		return new TextDecoder().decode(bytes);
	}

	stop(): void {
		this.stopIndexSubscription();
		for (const subscription of this.docSubscriptions.values()) {
			subscription();
		}
		this.docSubscriptions.clear();
		this.docPaths.clear();
		for (const timer of this.flushTimers.values()) {
			window.clearTimeout(timer);
		}
		this.flushTimers.clear();
	}

	private stopIndexSubscription(): void {
		if (!this.indexSubscription) {
			return;
		}
		this.indexSubscription();
		this.indexSubscription = null;
	}

	private getMutationClient(): ConvexClient | ConvexHttpClient {
		return this.host.getConvexRealtimeClient() ?? this.host.getConvexHttpClient();
	}

	private async handleDocHead(
		docId: string,
		path: string,
		head: DocHeadPayload,
		onUpdate: (payload: DocPayload) => void,
	): Promise<void> {
		if (!head?.doc) {
			onUpdate(null);
			return;
		}
		if (head.doc.deletedAtMs) {
			onUpdate({
				doc: head.doc,
				snapshot: null,
				ops: [],
				binaryHead: null,
			});
			return;
		}
		const lastSeq = await this.repo.lastSyncedSeq(docId, path);
		if (
			lastSeq > 0 &&
			head.doc.latestSeq <= lastSeq &&
			head.doc.latestSnapshotSeq <= lastSeq
		) {
			return;
		}
		await this.pullDocState(docId, path, onUpdate);
	}

	private async pullDocState(
		docId: string,
		path: string,
		onUpdate: (payload: DocPayload) => void,
	): Promise<void> {
		if (this.pullingDocs.has(docId)) {
			this.repullDocs.add(docId);
			return;
		}
		this.pullingDocs.add(docId);
		try {
			do {
				this.repullDocs.delete(docId);
				const afterSeq = await this.repo.lastSyncedSeq(docId, path);
				const payload = await this.host.getConvexHttpClient().query(api.sync.pullDoc, {
					convexSecret: this.host.settings.convexSecret,
					docId,
					afterSeq,
				});
				onUpdate((payload ?? null) as DocPayload);
			} while (this.repullDocs.has(docId));
		} catch (error) {
			console.error(`Live sync pull failed for ${docId}`, error);
		} finally {
			this.pullingDocs.delete(docId);
		}
	}
}
