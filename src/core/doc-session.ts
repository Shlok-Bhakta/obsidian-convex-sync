import * as Automerge from "@automerge/automerge/slim/next";
import type { DocHandle } from "@automerge/automerge-repo";
import { mergeArrays } from "@automerge/automerge-repo/helpers/mergeArrays.js";
import {
	AutomergeRepoStore,
	type AutomergeTextDoc,
} from "../storage/automerge-repo";

export type TextSplice = {
	pos: number;
	del: number;
	ins: string;
};

export type DocSessionTransport = {
	pushChanges(docId: string, changes: Uint8Array[]): Promise<number>;
	pushSnapshot?(docId: string, snapshot: Uint8Array): Promise<number>;
};

export type DocSessionOptions = {
	docId: string;
	repo: AutomergeRepoStore;
	transport: DocSessionTransport;
	onStateChange?: (text: string) => void;
	onRemotePatch?: (text: string) => void;
};

const LOCAL_PUSH_BATCH_DELAY_MS = 50;

export class DocSession {
	private handle: DocHandle<AutomergeTextDoc> | null = null;
	private opening: Promise<void> | null = null;
	private closed = false;
	private readonly inFlightWork = new Set<Promise<unknown>>();
	private pendingLocalChanges: Uint8Array[] = [];
	private pendingLocalChangeCount = 0;
	private pendingLocalPushTimer: ReturnType<typeof setTimeout> | null = null;
	private localPushQueue: Promise<void> = Promise.resolve();

	constructor(private readonly options: DocSessionOptions) {}

	async open(): Promise<void> {
		if (this.opening) {
			return this.opening;
		}
		this.opening = this.doOpen();
		return this.opening;
	}

	async applyLocalChange(splices: TextSplice[]): Promise<void> {
		if (this.closed) {
			throw new Error(`Document session ${this.options.docId} is closing`);
		}
		await this.trackWork(this.doApplyLocalChange(splices));
	}

	async applyLocalText(text: string): Promise<void> {
		if (this.closed) {
			throw new Error(`Document session ${this.options.docId} is closing`);
		}
		await this.trackWork(this.doApplyLocalText(text));
	}

	async applyRemoteChanges(changes: Uint8Array[]): Promise<void> {
		if (this.closed) {
			return;
		}
		await this.trackWork(this.doApplyRemoteChanges(changes));
	}

	async pushSnapshot(): Promise<void> {
		if (this.closed || !this.options.transport.pushSnapshot) {
			return;
		}
		await this.trackWork(this.doPushSnapshot());
	}

	async waitForIdle(): Promise<void> {
		await this.flushPendingLocalPushes();
		while (this.inFlightWork.size > 0) {
			await Promise.allSettled(Array.from(this.inFlightWork));
		}
	}

	async dispose(): Promise<void> {
		this.close();
		await this.waitForIdle();
		this.handle = null;
	}

	private async doApplyLocalChange(splices: TextSplice[]): Promise<void> {
		const handle = await this.requireHandle();
		const before = handle.doc();
		handle.change((doc) => {
			for (const splice of splices) {
				Automerge.splice(doc, ["text"], splice.pos, splice.del, splice.ins);
			}
		});
		const after = handle.doc();
		const changes = Automerge.getChanges(before, after);
		await this.flushAndTrackPush(handle, changes, splices.length);
	}

	private async doApplyLocalText(text: string): Promise<void> {
		const handle = await this.requireHandle();
		if (handle.doc().text === text) {
			return;
		}
		const before = handle.doc();
		handle.change((doc) => {
			Automerge.updateText(doc, ["text"], text);
		});
		const after = handle.doc();
		const changes = Automerge.getChanges(before, after);
		await this.flushAndTrackPush(handle, changes, 1);
	}

	private async flushAndTrackPush(
		handle: DocHandle<AutomergeTextDoc>,
		changes: Uint8Array[],
		changeCount: number,
	): Promise<void> {
		if (changes.length === 0) {
			return;
		}

		await this.options.repo.ensureFlushed(this.options.docId);
		console.info("[session] local change flushed", {
			docId: this.options.docId,
			spliceCount: changeCount,
			newHead: latestHead(handle.heads()),
		});

		this.pendingLocalChanges.push(...changes);
		this.pendingLocalChangeCount += changeCount;
		if (this.pendingLocalPushTimer !== null) {
			return;
		}
		this.pendingLocalPushTimer = setTimeout(() => {
			this.pendingLocalPushTimer = null;
			void this.flushPendingLocalPushes();
		}, LOCAL_PUSH_BATCH_DELAY_MS);
	}

	private async flushPendingLocalPushes(): Promise<void> {
		if (this.pendingLocalPushTimer !== null) {
			clearTimeout(this.pendingLocalPushTimer);
			this.pendingLocalPushTimer = null;
		}
		if (this.pendingLocalChanges.length === 0) {
			await this.localPushQueue.catch(() => undefined);
			return;
		}

		const changes = this.pendingLocalChanges;
		const changeCount = this.pendingLocalChangeCount;
		this.pendingLocalChanges = [];
		this.pendingLocalChangeCount = 0;

		const pushWork = this.localPushQueue
			.catch(() => undefined)
			.then(async () => {
				try {
					const serverCursor = await this.options.transport.pushChanges(
						this.options.docId,
						changes,
					);
					console.info("[session] push enqueued", {
						docId: this.options.docId,
						queueDepth: this.inFlightWork.size,
						changeCount,
						serverCursor,
					});
				} catch (error: unknown) {
					console.warn("[session] push failed", {
						docId: this.options.docId,
						changeCount,
						message: error instanceof Error ? error.message : String(error),
					});
				}
			});
		this.localPushQueue = pushWork.then(
			() => undefined,
			() => undefined,
		);
		await this.trackWork(pushWork);
	}

	private async doApplyRemoteChanges(changes: Uint8Array[]): Promise<void> {
		if (changes.length === 0) {
			return;
		}
		await this.open();
		if (this.closed || !this.handle) {
			return;
		}
		const handle = this.handle;
		handle.update((doc) => {
			for (const change of changes) {
				doc = Automerge.loadIncremental(doc, change);
			}
			return doc;
		});
		await this.options.repo.ensureFlushed(this.options.docId);
		const text = this.getTextSnapshot();
		console.info("[session] remote change applied", {
			docId: this.options.docId,
			changeHash: await sha256Hex(mergeArrays(changes)),
			newTextLength: text.length,
		});
		this.options.onRemotePatch?.(text);
		this.options.onStateChange?.(text);
	}

	private async doPushSnapshot(): Promise<void> {
		const handle = await this.requireHandle();
		if (!this.options.transport.pushSnapshot) {
			return;
		}
		try {
			const serverCursor = await this.options.transport.pushSnapshot(
				this.options.docId,
				Automerge.save(handle.doc()),
			);
			console.info("[session] snapshot pushed", {
				docId: this.options.docId,
				serverCursor,
			});
		} catch (error: unknown) {
			console.warn("[session] snapshot push failed", {
				docId: this.options.docId,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	getTextSnapshot(): string {
		if (!this.handle) {
			return "";
		}
		return this.handle.doc().text;
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		console.info("[session] closed", { docId: this.options.docId });
	}

	private async doOpen(): Promise<void> {
		if (this.closed) {
			return;
		}
		this.handle = await this.options.repo.getOrCreateHandle(this.options.docId);
		const text = this.getTextSnapshot();
		console.info("[session] opened", {
			docId: this.options.docId,
			textLength: text.length,
		});
		this.options.onStateChange?.(text);
	}

	private async requireHandle(): Promise<DocHandle<AutomergeTextDoc>> {
		await this.open();
		if (!this.handle) {
			throw new Error(`Document session ${this.options.docId} is not open`);
		}
		return this.handle;
	}

	private async trackWork<T>(work: Promise<T>): Promise<T> {
		this.inFlightWork.add(work);
		try {
			return await work;
		} finally {
			this.inFlightWork.delete(work);
		}
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function latestHead(heads: string[]): string | null {
	if (heads.length === 0) {
		return null;
	}
	return heads[heads.length - 1] ?? null;
}
