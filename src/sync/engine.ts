import { MarkdownView, Notice, TAbstractFile, TFile, TFolder } from "obsidian";
import type { ConvexHttpClient, ConvexClient } from "convex/browser";
import { LiveSyncRepo, probeLiveSyncSupport } from "./repo";
import {
	ConvexNetworkAdapter,
	type LiveSyncNetworkHost,
} from "./convex-network-adapter";
import { bootstrapLocalState, loadRemoteIndex } from "./reconciler";
import {
	folderPathForFile,
	isManagedSyncPath,
	kindForAbstractFile,
	LIVE_SYNC_TRASH_ROOT,
	randomDocId,
	sha256Bytes,
	type SyncKind,
	toArrayBuffer,
} from "./shared";

type IndexRow = {
	docId: string;
	kind: SyncKind;
	path: string;
	updatedAtMs: number;
	deletedAtMs: number | null;
	binaryHead: {
		contentHash: string;
		sizeBytes: number;
		updatedAtMs: number;
		url: string | null;
	} | null;
};

export type LiveSyncEngineHost = LiveSyncNetworkHost & {
	app: import("obsidian").App;
	registerEvent(event: import("obsidian").EventRef): void;
	registerInterval(id: number): void;
	setSyncStatus(message: string): void;
};

export class LiveSyncEngine {
	static async create(host: LiveSyncEngineHost): Promise<LiveSyncEngine | null> {
		if (!host.settings.liveSyncEnabled) {
			return null;
		}
		const supported = await probeLiveSyncSupport();
		if (!supported) {
			host.setSyncStatus("Convex sync: manual fallback");
			new Notice(
				"Live sync is unavailable on this platform/runtime. Falling back to manual sync.",
				8000,
			);
			return null;
		}
		const engine = new LiveSyncEngine(host);
		await engine.start();
		return engine;
	}

	private readonly repo = new LiveSyncRepo();
	private readonly network = new ConvexNetworkAdapter(this.host, this.repo);
	private readonly docsById = new Map<string, IndexRow>();
	private readonly docIdByPath = new Map<string, string>();
	private readonly suppressedPaths = new Map<string, number>();
	private readonly binaryHeads = new Map<string, number>();

	private constructor(private readonly host: LiveSyncEngineHost) {}

	private async start(): Promise<void> {
		this.host.setSyncStatus("Convex sync: loading live state");
		const remote = await loadRemoteIndex(this.host);
		await bootstrapLocalState(
			this.host,
			this.repo,
			this.network,
			(remote.docs ?? []).map((doc) => ({
				docId: doc.docId,
				path: doc.path,
				kind: doc.kind,
				binaryHead: doc.binaryHead,
			})),
		);
		await this.applyIndex((remote.docs ?? []) as IndexRow[]);
		this.network.startIndexSubscription((rows) => {
			void this.applyIndex(rows as IndexRow[]);
		});
		this.registerEvents();
		this.host.setSyncStatus("Convex sync: live");
	}

	stop(): void {
		this.network.stop();
	}

	private registerEvents(): void {
		this.host.registerEvent(
			(this.host.app.workspace as any).on("editor-change", (editor: any, view: any) => {
				if (!(view instanceof MarkdownView) || !(view.file instanceof TFile)) {
					return;
				}
				void this.syncTextFile(view.file, editor?.getValue?.());
			}),
		);
		this.host.registerEvent(
			this.host.app.vault.on("modify", (file) => {
				void this.handleLocalModify(file);
			}),
		);
		this.host.registerEvent(
			this.host.app.vault.on("create", (file) => {
				void this.handleLocalCreate(file);
			}),
		);
		this.host.registerEvent(
			this.host.app.vault.on("delete", (file) => {
				void this.handleLocalDelete(file);
			}),
		);
		this.host.registerEvent(
			this.host.app.vault.on("rename", (file, oldPath) => {
				void this.handleLocalRename(file, oldPath);
			}),
		);
	}

	private async applyIndex(rows: IndexRow[]): Promise<void> {
		for (const row of rows) {
			this.docsById.set(row.docId, row);
			this.docIdByPath.set(row.path, row.docId);
			if (row.deletedAtMs) {
				await this.moveLocalPathToTrash(row.path);
				continue;
			}
			if (row.kind === "folder") {
				await this.ensureFolder(row.path);
				continue;
			}
			if (row.kind === "binary") {
				await this.applyRemoteBinary(row);
				continue;
			}
			this.network.ensureDocSubscription(row.docId, row.path, (payload) => {
				void this.applyRemoteText(row.docId, row.path, payload);
			});
		}
	}

	private async applyRemoteText(docId: string, path: string, payload: any): Promise<void> {
		if (!payload?.doc || payload.doc.deletedAtMs) {
			await this.moveLocalPathToTrash(path);
			return;
		}
		if (!payload.snapshot && (payload.ops?.length ?? 0) === 0) {
			const legacyText = await this.network.downloadLegacyText(path);
			if (legacyText !== null) {
				const result = await this.repo.applyLocalText(docId, path, legacyText);
				if (result.changed) {
					this.network.scheduleFlush(docId, path);
				}
				await this.writeTextFile(path, legacyText);
				return;
			}
		}
		const snapshotBytes = payload.snapshot?.url
			? new Uint8Array(await this.network.downloadBytes(payload.snapshot.url))
			: null;
		const mergedText = await this.repo.mergeRemoteText(
			docId,
			path,
			{
				snapshotBytes,
				snapshotSeq: payload.snapshot?.upToSeq ?? 0,
				ops: payload.ops ?? [],
			},
			this.host.getPresenceSessionId(),
		);
		await this.writeTextFile(path, mergedText);
	}

	private async applyRemoteBinary(row: IndexRow): Promise<void> {
		if (!row.binaryHead?.url) {
			return;
		}
		const lastApplied = this.binaryHeads.get(row.docId) ?? 0;
		if (lastApplied >= row.binaryHead.updatedAtMs) {
			return;
		}
		const bytes = await this.network.downloadBytes(row.binaryHead.url);
		await this.writeBinaryFile(row.path, bytes);
		this.binaryHeads.set(row.docId, row.binaryHead.updatedAtMs);
	}

	private async handleLocalModify(file: TAbstractFile): Promise<void> {
		if (
			!(file instanceof TFile) ||
			!isManagedSyncPath(file.path, this.host.settings.syncIgnorePaths) ||
			this.isSuppressed(file.path)
		) {
			return;
		}
		if (kindForAbstractFile(file) === "binary") {
			await this.syncBinaryFile(file);
			return;
		}
		await this.syncTextFile(file);
	}

	private async handleLocalCreate(file: TAbstractFile): Promise<void> {
		if (
			!isManagedSyncPath(file.path, this.host.settings.syncIgnorePaths) ||
			this.isSuppressed(file.path)
		) {
			return;
		}
		if (file instanceof TFolder) {
			await this.ensureRemoteDoc(file.path, "folder");
			return;
		}
		if (file instanceof TFile && kindForAbstractFile(file) === "binary") {
			await this.syncBinaryFile(file);
			return;
		}
		if (file instanceof TFile) {
			await this.syncTextFile(file);
		}
	}

	private async handleLocalDelete(file: TAbstractFile): Promise<void> {
		if (
			!isManagedSyncPath(file.path, this.host.settings.syncIgnorePaths) ||
			this.isSuppressed(file.path)
		) {
			return;
		}
		const docId = this.docIdByPath.get(file.path);
		if (!docId) {
			return;
		}
		let frozenStorageId: string | undefined;
		if (file instanceof TFile && kindForAbstractFile(file) === "text") {
			const snapshot = await this.repo.exportSnapshot(docId, file.path);
			frozenStorageId = await this.network.uploadBytes(
				toArrayBuffer(snapshot),
				"application/octet-stream",
			);
		}
		await this.network.deleteDoc(docId, frozenStorageId);
	}

	private async handleLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (
			!isManagedSyncPath(file.path, this.host.settings.syncIgnorePaths) ||
			this.isSuppressed(file.path)
		) {
			return;
		}
		const docId = this.docIdByPath.get(oldPath);
		if (!docId) {
			return;
		}
		this.docIdByPath.delete(oldPath);
		this.docIdByPath.set(file.path, docId);
		await this.network.moveDoc(docId, file.path);
	}

	private async syncTextFile(file: TFile, textOverride?: string): Promise<void> {
		const docId = await this.ensureRemoteDoc(file.path, "text");
		const text = textOverride ?? (await this.host.app.vault.cachedRead(file));
		const changed = await this.repo.applyLocalText(docId, file.path, text);
		if (changed.changed) {
			this.network.scheduleFlush(docId, file.path);
		}
	}

	private async syncBinaryFile(file: TFile): Promise<void> {
		const docId = await this.ensureRemoteDoc(file.path, "binary");
		const bytes = await this.host.app.vault.readBinary(file);
		const storageId = await this.network.uploadBytes(bytes, "application/octet-stream");
		await this.network.putBinaryVersion({
			docId,
			storageId,
			contentHash: await sha256Bytes(bytes),
			sizeBytes: bytes.byteLength,
			updatedAtMs: file.stat.mtime,
		});
		this.binaryHeads.set(docId, file.stat.mtime);
	}

	private async ensureRemoteDoc(path: string, kind: SyncKind): Promise<string> {
		const existing = this.docIdByPath.get(path);
		if (existing) {
			return existing;
		}
		const docId = randomDocId();
		await this.network.createDoc({ docId, path, kind });
		this.docIdByPath.set(path, docId);
		this.docsById.set(docId, {
			docId,
			kind,
			path,
			updatedAtMs: Date.now(),
			deletedAtMs: null,
			binaryHead: null,
		});
		return docId;
	}

	private async writeTextFile(path: string, text: string): Promise<void> {
		await this.ensureFolder(folderPathForFile(path));
		const activeView = this.host.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file?.path === path) {
			const current = activeView.editor.getValue();
			if (current !== text) {
				this.suppressPath(path);
				activeView.editor.setValue(text);
			}
			return;
		}
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			const current = await this.host.app.vault.cachedRead(existing);
			if (current !== text) {
				this.suppressPath(path);
				await this.host.app.vault.modify(existing, text);
			}
			return;
		}
		this.suppressPath(path);
		await this.host.app.vault.create(path, text);
	}

	private async writeBinaryFile(path: string, bytes: ArrayBuffer): Promise<void> {
		await this.ensureFolder(folderPathForFile(path));
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			this.suppressPath(path);
			await this.host.app.vault.modifyBinary(existing, bytes);
			return;
		}
		this.suppressPath(path);
		await this.host.app.vault.createBinary(path, bytes);
	}

	private async moveLocalPathToTrash(path: string): Promise<void> {
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		if (!existing) {
			return;
		}
		const trashPath = `${LIVE_SYNC_TRASH_ROOT}/${path}`;
		await this.ensureFolder(folderPathForFile(trashPath));
		this.suppressPath(path);
		this.suppressPath(trashPath);
		await this.host.app.fileManager.renameFile(existing, trashPath);
	}

	private async ensureFolder(path: string | null): Promise<void> {
		if (!path) {
			return;
		}
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) {
			return;
		}
		const parent = folderPathForFile(path);
		if (parent) {
			await this.ensureFolder(parent);
		}
		this.suppressPath(path);
		await this.host.app.vault.createFolder(path);
	}

	private isSuppressed(path: string): boolean {
		const expiresAt = this.suppressedPaths.get(path);
		if (expiresAt === undefined) {
			return false;
		}
		if (expiresAt < Date.now()) {
			this.suppressedPaths.delete(path);
			return false;
		}
		return true;
	}

	private suppressPath(path: string, durationMs = 1500): void {
		this.suppressedPaths.set(path, Date.now() + durationMs);
	}
}
