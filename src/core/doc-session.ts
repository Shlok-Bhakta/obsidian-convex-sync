import * as Automerge from "@automerge/automerge/next";
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
};

export type DocSessionOptions = {
	docId: string;
	repo: AutomergeRepoStore;
	transport: DocSessionTransport;
	onStateChange?: (text: string) => void;
	onRemotePatch?: (text: string) => void;
};

export class DocSession {
	private handle: DocHandle<AutomergeTextDoc> | null = null;
	private opening: Promise<void> | null = null;
	private closed = false;
	private readonly pendingPushes: Promise<unknown>[] = [];

	constructor(private readonly options: DocSessionOptions) {}

	async open(): Promise<void> {
		if (this.opening) {
			return this.opening;
		}
		this.opening = this.doOpen();
		return this.opening;
	}

	async applyLocalChange(splices: TextSplice[]): Promise<void> {
		const handle = await this.requireHandle();
		const before = handle.doc();
		handle.change((doc) => {
			for (const splice of splices) {
				Automerge.splice(doc, ["text"], splice.pos, splice.del, splice.ins);
			}
		});
		const after = handle.doc();
		const changes = Automerge.getChanges(before, after);

		await this.options.repo.ensureFlushed(this.options.docId);
		console.info("[session] local change flushed", {
			docId: this.options.docId,
			spliceCount: splices.length,
			newHead: latestHead(handle.heads()),
		});

		const push = this.options.transport
			.pushChanges(this.options.docId, changes)
			.then((serverCursor) => {
				console.info("[session] push enqueued", {
					docId: this.options.docId,
					queueDepth: this.pendingPushes.length,
					serverCursor,
				});
			})
			.catch((error: unknown) => {
				console.warn("[session] push failed", {
					docId: this.options.docId,
					message: error instanceof Error ? error.message : String(error),
				});
			});
		this.pendingPushes.push(push);
		void push.finally(() => {
			const index = this.pendingPushes.indexOf(push);
			if (index >= 0) {
				this.pendingPushes.splice(index, 1);
			}
		});
	}

	async applyRemoteChanges(changes: Uint8Array[]): Promise<void> {
		if (changes.length === 0) {
			return;
		}
		const handle = await this.requireHandle();
		handle.update((doc) => Automerge.loadIncremental(doc, mergeArrays(changes)));
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

	getTextSnapshot(): string {
		if (!this.handle) {
			return "";
		}
		return this.handle.doc().text;
	}

	close(): void {
		this.closed = true;
		this.handle = null;
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
