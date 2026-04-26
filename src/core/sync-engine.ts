import type { ConvexClient } from "convex/browser";
import { createAutomergeDocumentId, PathMap } from "../obsidian/path-map";
import { LocalMetaStore } from "../storage/local-meta-store";
import { AutomergeRepoStore } from "../storage/automerge-repo";
import {
	ConvexAutomergeTransport,
	type DocPathChange,
	type PulledAutomergeChange,
} from "../transport/convex-client";
import { DocSession, type TextSplice } from "./doc-session";
import { mergeTexts } from "./text-merge";

export type SyncEngineOptions = {
	vaultId: string;
	convexClient: ConvexClient;
	convexSecret: string;
};

export type OpenDocumentSession = {
	docId: string;
	path: string;
	getTextSnapshot(): string;
	applyLocalChange(splices: TextSplice[]): Promise<void>;
	close(): void;
};

export type OpenDocOptions = {
	onInitialState?: (text: string) => void;
	onRemotePatch?: (text: string) => void;
};

export type ReconcilePathOptions = {
	onBeforeFallbackMerge?: (context: {
		docId: string;
		path: string;
		localText: string;
		remoteText: string;
	}) => Promise<void>;
	preferRemoteOnMissingBase?: boolean;
};

export type ReconcilePathResult = {
	docId: string;
	path: string;
	text: string;
	changed: boolean;
	usedFallbackBackup: boolean;
};

type SessionSubscriber = {
	id: string;
	onRemotePatch?: (text: string) => void;
};

type SessionEntry = {
	docId: string;
	path: string;
	session: DocSession;
	unsubscribe: () => void;
	subscribers: Map<string, SessionSubscriber>;
	queue: Promise<void>;
	lastRemoteClientId: string | null;
	disposing: Promise<void> | null;
};

export class SyncEngine {
	private metaStore: LocalMetaStore | null = null;
	private repo: AutomergeRepoStore | null = null;
	private pathMap: PathMap | null = null;
	private transport: ConvexAutomergeTransport | null = null;
	private clientId = "";
	private readonly sessions = new Map<string, SessionEntry>();
	private readonly pendingEntries = new Map<string, Promise<SessionEntry>>();

	private constructor(private readonly options: SyncEngineOptions) {}

	static async boot(options: SyncEngineOptions): Promise<SyncEngine> {
		const engine = new SyncEngine(options);
		engine.metaStore = await LocalMetaStore.open({ vaultId: options.vaultId });
		engine.repo = await AutomergeRepoStore.open({ vaultId: options.vaultId });
		engine.pathMap = new PathMap(engine.metaStore);
		engine.clientId = await engine.metaStore.getClientId();
		engine.transport = new ConvexAutomergeTransport({
			client: options.convexClient,
			convexSecret: options.convexSecret,
			clientId: engine.clientId,
		});
		console.info("[engine] sync_engine_booted", { vaultId: options.vaultId });
		return engine;
	}

	async openDoc(path: string, options: OpenDocOptions = {}): Promise<OpenDocumentSession> {
		const docId = await this.resolveDocId(path);
		const entry = await this.getOrCreateEntry(docId, path);
		const subscriber: SessionSubscriber = {
			id: crypto.randomUUID(),
			onRemotePatch: options.onRemotePatch,
		};
		entry.subscribers.set(subscriber.id, subscriber);
		options.onInitialState?.(entry.session.getTextSnapshot());

		return {
			docId,
			path: entry.path,
			getTextSnapshot: () => entry.session.getTextSnapshot(),
			applyLocalChange: (splices) =>
				this.enqueueEntry(entry, () => entry.session.applyLocalChange(splices)),
			close: () => {
				entry.subscribers.delete(subscriber.id);
			},
		};
	}

	async reconcilePath(
		path: string,
		localText: string,
		options: ReconcilePathOptions = {},
	): Promise<ReconcilePathResult> {
		const docId = await this.resolveDocId(path);
		const entry = await this.getOrCreateEntry(docId, path);
		return this.enqueueEntry(entry, async () => {
			const metaStore = this.requireMetaStore();
			const base = await metaStore.getLastReconciledText(docId);
			const remote = entry.session.getTextSnapshot();

			if (base === null) {
				if (localText === remote) {
					await metaStore.setLastReconciledText(docId, localText);
					return {
						docId,
						path: entry.path,
						text: localText,
						changed: false,
						usedFallbackBackup: false,
					};
				}

				if (options.preferRemoteOnMissingBase) {
					await metaStore.setLastReconciledText(docId, remote);
					return {
						docId,
						path: entry.path,
						text: remote,
						changed: true,
						usedFallbackBackup: false,
					};
				}

				await options.onBeforeFallbackMerge?.({
					docId,
					path: entry.path,
					localText,
					remoteText: remote,
				});
				const merged = mergeTexts({
					base: "",
					local: localText,
					remote,
					localClientId: this.clientId,
					remoteClientId: entry.lastRemoteClientId ?? `remote:${docId}`,
				});
				if (merged.text !== remote) {
					await entry.session.applyLocalText(merged.text);
				}
				await metaStore.setLastReconciledText(docId, merged.text);
				return {
					docId,
					path: entry.path,
					text: merged.text,
					changed: merged.changed,
					usedFallbackBackup: true,
				};
			}

			if (localText === remote) {
				await metaStore.setLastReconciledText(docId, localText);
				return {
					docId,
					path: entry.path,
					text: localText,
					changed: false,
					usedFallbackBackup: false,
				};
			}

			if (base === localText && base !== remote) {
				await metaStore.setLastReconciledText(docId, remote);
				return {
					docId,
					path: entry.path,
					text: remote,
					changed: true,
					usedFallbackBackup: false,
				};
			}

			if (base === remote && base !== localText) {
				await entry.session.applyLocalText(localText);
				await metaStore.setLastReconciledText(docId, localText);
				return {
					docId,
					path: entry.path,
					text: localText,
					changed: true,
					usedFallbackBackup: false,
				};
			}

			const merged = mergeTexts({
				base,
				local: localText,
				remote,
				localClientId: this.clientId,
				remoteClientId: entry.lastRemoteClientId ?? `remote:${docId}`,
			});
			if (merged.text !== remote) {
				await entry.session.applyLocalText(merged.text);
			}
			await metaStore.setLastReconciledText(docId, merged.text);
			return {
				docId,
				path: entry.path,
				text: merged.text,
				changed: merged.changed,
				usedFallbackBackup: false,
			};
		});
	}

	async syncFileText(path: string, text: string): Promise<void> {
		await this.reconcilePath(path, text);
	}

	async deletePath(path: string): Promise<void> {
		const pathMap = this.requirePathMap();
		const transport = this.requireTransport();
		const docId = await pathMap.remove(path);
		if (docId) {
			await this.disposeEntry(docId);
		}
		await transport.deleteDocPath(path);
	}

	async renamePath(oldPath: string, newPath: string): Promise<void> {
		const pathMap = this.requirePathMap();
		const docId = await pathMap.getDocId(oldPath);
		if (docId) {
			await pathMap.rename(oldPath, newPath);
			const entry = this.sessions.get(docId);
			if (entry) {
				entry.path = newPath;
			}
		}
		await this.requireTransport().renameDocPath(oldPath, newPath);
	}

	async getLocalPathForDocId(docId: string): Promise<string | null> {
		return this.requirePathMap().getPathForDocId(docId);
	}

	async bindRemotePath(docId: string, path: string): Promise<void> {
		const pathMap = this.requirePathMap();
		const existingPath = await pathMap.getPathForDocId(docId);
		if (existingPath && existingPath !== path) {
			await pathMap.updatePathForDoc(docId, path);
		} else {
			await pathMap.getOrCreate(path, docId);
		}
		const entry = this.sessions.get(docId);
		if (entry) {
			entry.path = path;
		}
	}

	getClientId(): string {
		return this.clientId;
	}

	watchPathChanges(onChanges: (changes: DocPathChange[]) => void): () => void {
		return this.requireTransport().watchDocPathChanges(onChanges);
	}

	async listRemotePathChanges(): Promise<DocPathChange[]> {
		return this.requireTransport().listDocPathChanges(0);
	}

	closeDoc(docId: string): void {
		void this.disposeEntry(docId);
	}

	async dispose(): Promise<void> {
		await Promise.allSettled(Array.from(this.pendingEntries.values()));
		await Promise.allSettled(
			Array.from(this.sessions.keys(), (docId) => this.disposeEntry(docId)),
		);
		this.transport?.dispose();
		await this.repo?.dispose({ closeStorage: true });
		this.metaStore?.dispose();
		this.transport = null;
		this.repo = null;
		this.metaStore = null;
		this.pathMap = null;
	}

	private async resolveDocId(path: string): Promise<string> {
		const pathMap = this.requirePathMap();
		const transport = this.requireTransport();
		return (
			(await pathMap.getDocId(path)) ??
			(await pathMap.getOrCreate(
				path,
				await transport.getOrCreateDocIdForPath(path, createAutomergeDocumentId()),
			))
		);
	}

	private async getOrCreateEntry(docId: string, path: string): Promise<SessionEntry> {
		const existing = this.sessions.get(docId);
		if (existing) {
			existing.path = path;
			return existing;
		}

		const pending = this.pendingEntries.get(docId);
		if (pending) {
			const entry = await pending;
			entry.path = path;
			return entry;
		}

		const opening = this.createEntry(docId, path).finally(() => {
			this.pendingEntries.delete(docId);
		});
		this.pendingEntries.set(docId, opening);
		return opening;
	}

	private async createEntry(docId: string, path: string): Promise<SessionEntry> {
		const repo = this.requireRepo();
		const transport = this.requireTransport();
		let entry: SessionEntry;
		const session = new DocSession({
			docId,
			repo,
			transport,
			onRemotePatch: (text) => {
				for (const subscriber of entry.subscribers.values()) {
					subscriber.onRemotePatch?.(text);
				}
			},
		});
		entry = {
			docId,
			path,
			session,
			unsubscribe: () => undefined,
			subscribers: new Map(),
			queue: Promise.resolve(),
			lastRemoteClientId: null,
			disposing: null,
		};
		this.sessions.set(docId, entry);

		try {
			await this.enqueueEntry(entry, () => entry.session.open());
			entry.unsubscribe = transport.watchDoc(docId, (changes) => {
				const remoteClientId = selectRemoteClientId(changes, this.clientId);
				if (remoteClientId) {
					entry.lastRemoteClientId = remoteClientId;
				}
				void this.enqueueEntry(entry, () =>
					entry.session.applyRemoteChanges(changes),
				).catch((error: unknown) => {
					console.warn("[engine] remote apply skipped", {
						docId,
						message: error instanceof Error ? error.message : String(error),
					});
				});
			});

			const missing = await transport.pullMissingChanges(docId, 0);
			const remoteClientId = selectRemoteClientId(missing, this.clientId);
			if (remoteClientId) {
				entry.lastRemoteClientId = remoteClientId;
			}
			await this.enqueueEntry(entry, () => entry.session.applyRemoteChanges(missing));
			return entry;
		} catch (error) {
			this.sessions.delete(docId);
			entry.unsubscribe();
			throw error;
		}
	}

	private async disposeEntry(docId: string): Promise<void> {
		const entry = this.sessions.get(docId);
		if (!entry) {
			return;
		}
		if (entry.disposing) {
			await entry.disposing;
			return;
		}

		this.sessions.delete(docId);
		entry.disposing = (async () => {
			entry.unsubscribe();
			await entry.queue.catch(() => undefined);
			await entry.session.dispose();
			entry.subscribers.clear();
		})();
		await entry.disposing;
	}

	private async enqueueEntry<T>(
		entry: SessionEntry,
		work: () => Promise<T>,
	): Promise<T> {
		if (entry.disposing) {
			throw new Error(`Document session ${entry.docId} is disposing`);
		}
		const scheduled = entry.queue
			.catch(() => undefined)
			.then(async () => work());
		entry.queue = scheduled.then(
			() => undefined,
			() => undefined,
		);
		return scheduled;
	}

	private requireMetaStore(): LocalMetaStore {
		if (!this.metaStore) {
			throw new Error("SyncEngine has not booted meta store");
		}
		return this.metaStore;
	}

	private requirePathMap(): PathMap {
		if (!this.pathMap) {
			throw new Error("SyncEngine has not booted path map");
		}
		return this.pathMap;
	}

	private requireRepo(): AutomergeRepoStore {
		if (!this.repo) {
			throw new Error("SyncEngine has not booted repo");
		}
		return this.repo;
	}

	private requireTransport(): ConvexAutomergeTransport {
		if (!this.transport) {
			throw new Error("SyncEngine has not booted transport");
		}
		return this.transport;
	}
}

function selectRemoteClientId(
	changes: PulledAutomergeChange[],
	localClientId: string,
): string | null {
	const remoteClientIds = changes
		.map((change) => change.clientId)
		.filter((clientId) => clientId !== localClientId)
		.sort();
	return remoteClientIds[0] ?? null;
}
