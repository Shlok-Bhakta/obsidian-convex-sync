import type { ConvexClient } from "convex/browser";
import { PathMap } from "../obsidian/path-map";
import { LocalMetaStore } from "../storage/local-meta-store";
import { AutomergeRepoStore } from "../storage/automerge-repo";
import {
	ConvexAutomergeTransport,
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

export class SyncEngine {
	private metaStore: LocalMetaStore | null = null;
	private repo: AutomergeRepoStore | null = null;
	private pathMap: PathMap | null = null;
	private transport: ConvexAutomergeTransport | null = null;
	private readonly sessions = new Map<
		string,
		{ session: DocSession; unsubscribe: () => void; path: string }
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

	async openDoc(path: string): Promise<OpenDocumentSession> {
		const pathMap = this.requirePathMap();
		const repo = this.requireRepo();
		const transport = this.requireTransport();
		const docId = await pathMap.getOrCreate(path);

		const session = new DocSession({
			docId,
			repo,
			transport,
		});
		await session.open();

		const unsubscribe = transport.watchDoc(docId, (changes) => {
			void this.applyRemoteChanges(docId, changes);
		});
		this.sessions.set(docId, { session, unsubscribe, path });

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
		await entry.session.applyRemoteChanges(changes.map((change) => change.data));
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
