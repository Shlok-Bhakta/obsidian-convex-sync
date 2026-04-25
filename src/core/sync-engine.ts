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

export class SyncEngine {
	private metaStore: LocalMetaStore | null = null;
	private repo: AutomergeRepoStore | null = null;
	private pathMap: PathMap | null = null;
	private transport: ConvexAutomergeTransport | null = null;
	private readonly sessions = new Map<
		string,
		{
			session: DocSession;
			unsubscribe: () => void;
			path: string;
			remoteApplyQueue: Promise<void>;
		}
	>();

	private constructor(private readonly options: SyncEngineOptions) {}

	static async boot(options: SyncEngineOptions): Promise<SyncEngine> {
		const engine = new SyncEngine(options);
		engine.metaStore = await LocalMetaStore.open({ vaultId: options.vaultId });
		engine.repo = await AutomergeRepoStore.open({ vaultId: options.vaultId });
		engine.pathMap = new PathMap(engine.metaStore);
		engine.transport = new ConvexAutomergeTransport({
			client: options.convexClient,
			convexSecret: options.convexSecret,
			clientId: await engine.metaStore.getClientId(),
		});
		console.info("[engine] sync_engine_booted", { vaultId: options.vaultId });
		return engine;
	}

	async openDoc(path: string, options: OpenDocOptions = {}): Promise<OpenDocumentSession> {
		const pathMap = this.requirePathMap();
		const repo = this.requireRepo();
		const transport = this.requireTransport();
		const localDocId = await pathMap.getDocId(path);
		const docId =
			localDocId ??
			(await pathMap.getOrCreate(
				path,
				await transport.getOrCreateDocIdForPath(
					path,
					createAutomergeDocumentId(),
				),
			));

		this.closeDoc(docId);

		const session = new DocSession({
			docId,
			repo,
			transport,
			onStateChange: options.onInitialState,
			onRemotePatch: options.onRemotePatch,
		});
		await session.open();

		const unsubscribe = transport.watchDoc(docId, (changes) => {
			void this.applyRemoteChanges(docId, changes);
		});
		this.sessions.set(docId, {
			session,
			unsubscribe,
			path,
			remoteApplyQueue: Promise.resolve(),
		});

		const missing = await transport.pullMissingChanges(docId, 0);
		await this.applyRemoteChanges(docId, missing);

		return {
			docId,
			path,
			getTextSnapshot: () => session.getTextSnapshot(),
			applyLocalChange: (splices) => session.applyLocalChange(splices),
			close: () => this.closeDoc(docId),
		};
	}

	async syncFileText(path: string, text: string): Promise<void> {
		const session = await this.openDoc(path);
		const current = session.getTextSnapshot();
		if (current !== text) {
			await session.applyLocalChange([
				{ pos: 0, del: current.length, ins: text },
			]);
		}
		session.close();
	}

	async deletePath(path: string): Promise<void> {
		const pathMap = this.requirePathMap();
		const transport = this.requireTransport();
		const docId = await pathMap.remove(path);
		if (docId) {
			this.closeDoc(docId);
		}
		await transport.deleteDocPath(path);
	}

	async renamePath(oldPath: string, newPath: string): Promise<void> {
		const pathMap = this.requirePathMap();
		const docId = await pathMap.getDocId(oldPath);
		if (docId) {
			await pathMap.rename(oldPath, newPath);
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
			return;
		}
		await pathMap.getOrCreate(path, docId);
	}

	watchPathChanges(onChanges: (changes: DocPathChange[]) => void): () => void {
		return this.requireTransport().watchDocPathChanges(onChanges);
	}

	closeDoc(docId: string): void {
		const entry = this.sessions.get(docId);
		if (!entry) {
			return;
		}
		entry.unsubscribe();
		entry.session.close();
		this.sessions.delete(docId);
	}

	async dispose(): Promise<void> {
		for (const docId of Array.from(this.sessions.keys())) {
			this.closeDoc(docId);
		}
		this.transport?.dispose();
		await this.repo?.dispose();
		this.metaStore?.dispose();
	}

	private async applyRemoteChanges(
		docId: string,
		changes: PulledAutomergeChange[],
	): Promise<void> {
		const entry = this.sessions.get(docId);
		if (!entry) {
			return;
		}
		entry.remoteApplyQueue = entry.remoteApplyQueue
			.catch(() => undefined)
			.then(async () => {
				if (this.sessions.get(docId) !== entry) {
					return;
				}
				await entry.session.applyRemoteChanges(
					changes.map((change) => change.data),
				);
			})
			.catch((error: unknown) => {
				console.warn("[engine] remote apply skipped", {
					docId,
					message: error instanceof Error ? error.message : String(error),
				});
			});
		await entry.remoteApplyQueue;
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
