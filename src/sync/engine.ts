import { MarkdownView, Notice, TAbstractFile, TFile, TFolder } from "obsidian";
import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import {
	collectTrackedObsidianState,
	ensureAdapterFolderExists,
	isObsidianPath,
} from "../obsidian-config";
import { LiveSyncRepo, probeLiveSyncSupport } from "./repo";
import {
	ConvexNetworkAdapter,
	type LiveSyncNetworkHost,
} from "./convex-network-adapter";
import { bootstrapLocalState, loadRemoteIndex } from "./reconciler";
import {
	folderPathForFile,
	isBinaryPath,
	isManagedSyncPath,
	kindForAbstractFile,
	LIVE_SYNC_TRASH_ROOT,
	randomDocId,
	sha256Bytes,
	type SyncKind,
	toArrayBuffer,
} from "./shared";

const OBSIDIAN_SCAN_INTERVAL_MS = 10_000;

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
	private syncingObsidian = false;
	private pendingObsidianSync = false;

	private constructor(private readonly host: LiveSyncEngineHost) {}

	async syncNow(options?: { pruneRemoteDeletions?: boolean }): Promise<void> {
		const remote = await loadRemoteIndex(this.host);
		const remoteDocs = (remote.docs ?? []) as IndexRow[];
		await bootstrapLocalState(
			this.host,
			this.repo,
			this.network,
			remoteDocs.map((doc) => ({
				docId: doc.docId,
				path: doc.path,
				kind: doc.kind,
				updatedAtMs: doc.updatedAtMs,
				binaryHead: doc.binaryHead,
			})),
		);
		if (options?.pruneRemoteDeletions) {
			await this.deleteMissingRemoteDocs(remoteDocs);
		}
		await this.flushAllTextDocs();
		const refreshed = await loadRemoteIndex(this.host);
		await this.applyIndex((refreshed.docs ?? []) as IndexRow[]);
	}

	private async start(): Promise<void> {
		this.host.setSyncStatus("Convex sync: loading live state");
		await this.syncNow({ pruneRemoteDeletions: false });
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
		const interval = window.setInterval(() => {
			this.queueObsidianSync();
		}, OBSIDIAN_SCAN_INTERVAL_MS);
		this.host.registerInterval(interval);
	}

	private async applyIndex(rows: IndexRow[]): Promise<void> {
		for (const row of rows) {
			const previous = this.docsById.get(row.docId);
			if (previous && previous.path !== row.path) {
				this.docIdByPath.delete(previous.path);
				await this.moveLocalPathToTrash(previous.path);
			}
			this.docsById.set(row.docId, row);
			if (row.deletedAtMs) {
				this.docIdByPath.delete(row.path);
				await this.moveLocalPathToTrash(row.path);
				continue;
			}
			this.docIdByPath.set(row.path, row.docId);
			if (row.kind === "folder") {
				await this.ensureFolder(row.path);
				continue;
			}
			if (row.kind === "binary") {
				await this.applyRemoteBinary(row);
				continue;
			}
			this.network.ensureDocSubscription(row.docId, row.path, (payload) => {
				void this.applyRemoteText(row.docId, payload);
			});
		}
	}

	private async applyRemoteText(docId: string, payload: any): Promise<void> {
		const path =
			this.docsById.get(docId)?.path ??
			(typeof payload?.doc?.path === "string" ? payload.doc.path : null);
		if (!path) {
			return;
		}
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
		await this.deleteRemoteDoc({
			docId,
			path: file.path,
			kind:
				file instanceof TFolder
					? "folder"
					: kindForAbstractFile(file),
		});
	}

	private async handleLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
		const oldManaged = isManagedSyncPath(oldPath, this.host.settings.syncIgnorePaths);
		const newManaged = isManagedSyncPath(file.path, this.host.settings.syncIgnorePaths);
		if ((!oldManaged && !newManaged) || this.isSuppressed(file.path)) {
			return;
		}
		const docId = this.docIdByPath.get(oldPath);
		if (oldManaged && docId && !newManaged) {
			await this.deleteRemoteDoc({
				docId,
				path: oldPath,
				kind:
					file instanceof TFolder
						? "folder"
						: kindForAbstractFile(file),
			});
			return;
		}
		if (!oldManaged && newManaged) {
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
			return;
		}
		if (!docId || !newManaged) {
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

	private async syncObsidianTextPath(path: string): Promise<void> {
		const docId = await this.ensureRemoteDoc(path, "text");
		const text = await this.host.app.vault.adapter.read(path);
		const changed = await this.repo.applyLocalText(docId, path, text);
		if (changed.changed) {
			this.network.scheduleFlush(docId, path);
		}
	}

	private async syncObsidianBinaryPath(path: string, updatedAtMs: number): Promise<void> {
		const docId = await this.ensureRemoteDoc(path, "binary");
		const bytes = await this.host.app.vault.adapter.readBinary(path);
		const storageId = await this.network.uploadBytes(bytes, "application/octet-stream");
		await this.network.putBinaryVersion({
			docId,
			storageId,
			contentHash: await sha256Bytes(bytes),
			sizeBytes: bytes.byteLength,
			updatedAtMs,
		});
		this.binaryHeads.set(docId, updatedAtMs);
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

	private async deleteMissingRemoteDocs(remoteDocs: IndexRow[]): Promise<void> {
		const localPaths = await this.collectCurrentLocalPaths();
		for (const row of remoteDocs) {
			if (row.deletedAtMs || localPaths.has(row.path)) {
				continue;
			}
			await this.deleteRemoteDoc(row);
		}
	}

	private async collectCurrentLocalPaths(): Promise<Set<string>> {
		const paths = new Set<string>();
		for (const entry of this.host.app.vault.getAllLoadedFiles()) {
			if (isManagedSyncPath(entry.path, this.host.settings.syncIgnorePaths)) {
				paths.add(entry.path);
			}
		}
		const trackedObsidian = await collectTrackedObsidianState(
			this.host.app,
			this.host.settings.syncIgnorePaths,
		);
		for (const file of trackedObsidian.files) {
			paths.add(file.path);
		}
		return paths;
	}

	private async flushAllTextDocs(): Promise<void> {
		for (const row of this.docsById.values()) {
			if (row.kind !== "text" || row.deletedAtMs) {
				continue;
			}
			await this.network.flushDoc(row.docId, row.path);
		}
	}

	private queueObsidianSync(): void {
		if (this.syncingObsidian) {
			this.pendingObsidianSync = true;
			return;
		}
		void this.syncObsidianState();
	}

	private async syncObsidianState(): Promise<void> {
		this.syncingObsidian = true;
		try {
			const state = await collectTrackedObsidianState(
				this.host.app,
				this.host.settings.syncIgnorePaths,
			);
			const currentPaths = new Set(state.files.map((file) => file.path));
			for (const file of state.files) {
				if (this.isSuppressed(file.path)) {
					continue;
				}
				const row = this.getRowByPath(file.path);
				if (isBinaryPath(file.path)) {
					const remoteUpdatedAtMs =
						row?.kind === "binary" ? row.binaryHead?.updatedAtMs ?? 0 : 0;
					if (!row || file.updatedAtMs > remoteUpdatedAtMs) {
						await this.syncObsidianBinaryPath(file.path, file.updatedAtMs);
					}
					continue;
				}
				if (
					row?.kind === "text" &&
					row.updatedAtMs >= file.updatedAtMs
				) {
					continue;
				}
				await this.syncObsidianTextPath(file.path);
			}
			for (const row of this.docsById.values()) {
				if (
					!isObsidianPath(row.path) ||
					row.deletedAtMs ||
					currentPaths.has(row.path) ||
					this.isSuppressed(row.path)
				) {
					continue;
				}
				await this.deleteRemoteDoc(row);
			}
		} finally {
			this.syncingObsidian = false;
			if (this.pendingObsidianSync) {
				this.pendingObsidianSync = false;
				this.queueObsidianSync();
			}
		}
	}

	private getRowByPath(path: string): IndexRow | null {
		const docId = this.docIdByPath.get(path);
		return docId ? (this.docsById.get(docId) ?? null) : null;
	}

	private async deleteRemoteDoc(row: {
		docId: string;
		path: string;
		kind: SyncKind;
	}): Promise<void> {
		let frozenStorageId: string | undefined;
		if (row.kind === "text") {
			const snapshot = await this.repo.exportSnapshot(row.docId, row.path);
			frozenStorageId = await this.network.uploadBytes(
				toArrayBuffer(snapshot),
				"application/octet-stream",
			);
		}
		await this.network.deleteDoc(row.docId, frozenStorageId);
		this.docIdByPath.delete(row.path);
		const existing = this.docsById.get(row.docId);
		if (existing) {
			this.docsById.set(row.docId, {
				...existing,
				deletedAtMs: Date.now(),
			});
		}
	}

	private async writeTextFile(path: string, text: string): Promise<void> {
		if (isObsidianPath(path)) {
			await ensureAdapterFolderExists(this.host.app, folderPathForFile(path) ?? "");
			const current = await this.host.app.vault.adapter.read(path).catch(() => null);
			if (current === text) {
				return;
			}
			this.suppressPath(path);
			await this.host.app.vault.adapter.write(path, text);
			return;
		}
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
		if (isObsidianPath(path)) {
			await ensureAdapterFolderExists(this.host.app, folderPathForFile(path) ?? "");
			this.suppressPath(path);
			await this.host.app.vault.adapter.writeBinary(path, bytes);
			return;
		}
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
		if (isObsidianPath(path)) {
			const exists = await this.host.app.vault.adapter.exists(path);
			if (!exists) {
				return;
			}
			this.suppressPath(path);
			await this.host.app.vault.adapter.remove(path);
			return;
		}
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
		if (isObsidianPath(path)) {
			await ensureAdapterFolderExists(this.host.app, path);
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
