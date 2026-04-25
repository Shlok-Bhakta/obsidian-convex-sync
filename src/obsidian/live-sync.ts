import {
	MarkdownView,
	Notice,
	TAbstractFile,
	TFile,
	TFolder,
	normalizePath,
	type App,
	type Editor,
	type EventRef,
	type MarkdownFileInfo,
} from "obsidian";
import type { ConvexClient, ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { MyPluginSettings } from "../settings";
import {
	SyncEngine,
	type OpenDocumentSession,
} from "../core/sync-engine";
import { createEditorAdapter, type EditorAdapter } from "./editor-adapter";
import type { DocPathChange } from "../transport/convex-client";
import {
	ensureVaultFolderExists,
	isTextSyncFile,
} from "../lib/obsidian-vault";
import { isMergeBackupPath } from "../lib/merge-backups";
import { folderPathForFile } from "../lib/path";
import {
	readRemoteFileBytes,
	uploadLocalFile,
} from "../file-sync/remote-transfer";
import { listLocalEntries } from "../file-sync/local-entries";
import { isDotObsidianPath, shouldIgnoreVaultPath } from "../file-sync/path-rules";
import {
	applyDotObsidianSnapshot,
	showConfigRestartNotice,
} from "../file-sync/config-sync";
import type { Snapshot } from "../file-sync/types";

export type LiveSyncHost = {
	app: App;
	settings: MyPluginSettings;
	getRealtimeClient(): ConvexClient | null;
	getFileSyncClient?(): ConvexHttpClient | null;
	getPresenceSessionId?(): string;
	setStatus(text: string): void;
};

export type LiveSyncController = {
	openActiveFile(): Promise<void>;
	dispose(): Promise<void>;
};

type OpenEditorBinding = {
	file: TFile;
	editor: Editor;
	session: OpenDocumentSession;
	adapter: EditorAdapter;
};

type FolderSnapshotRow = {
	path: string;
	updatedAtMs: number;
	isExplicitlyEmpty: boolean;
	updatedByClientId: string;
};

const FOLDER_SYNC_DEBOUNCE_MS = 250;
const EDITOR_CHANGE_DEBOUNCE_MS = 75;

export function startObsidianLiveSync(host: LiveSyncHost): LiveSyncController {
	const controller = new ObsidianLiveSyncController(host);
	controller.start();
	return controller;
}

class ObsidianLiveSyncController implements LiveSyncController {
	private engine: SyncEngine | null = null;
	private engineBoot: Promise<SyncEngine | null> | null = null;
	private current: OpenEditorBinding | null = null;
	private readonly openingByPath = new Map<string, Promise<OpenEditorBinding | null>>();
	private readonly suppressPathEvents = new Set<string>();
	private readonly pendingModifyTimers = new Map<string, number>();
	private readonly workspaceRefs: EventRef[] = [];
	private readonly vaultRefs: EventRef[] = [];
	private pathChangesUnsubscribe: (() => void) | null = null;
	private folderSnapshotUnsubscribe: (() => void) | null = null;
	private configSnapshotUnsubscribe: (() => void) | null = null;
	private folderSyncTimer: number | null = null;
	private configSnapshotTimer: number | null = null;
	private editorChangeTimer: number | null = null;
	private remoteFolders: Map<string, FolderSnapshotRow> | null = null;
	private latestConfigSnapshot: Snapshot | null = null;
	private lastConfigSnapshotSignature: string | null = null;
	private disposing: Promise<void> | null = null;
	private disposed = false;
	private started = false;

	constructor(private readonly host: LiveSyncHost) {}

	start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.workspaceRefs.push(
			this.host.app.workspace.on("file-open", () => {
				void this.openActiveFile();
			}),
		);
		this.workspaceRefs.push(
			this.host.app.workspace.on("editor-change", (editor, info) => {
				void this.handleEditorChange(editor, info);
			}),
		);
		this.vaultRefs.push(
			this.host.app.vault.on("create", (file) => {
				void this.handleVaultCreate(file);
			}),
		);
		this.vaultRefs.push(
			this.host.app.vault.on("modify", (file) => {
				void this.handleVaultModify(file);
			}),
		);
		this.vaultRefs.push(
			this.host.app.vault.on("delete", (file) => {
				void this.handleVaultDelete(file);
			}),
		);
		this.vaultRefs.push(
			this.host.app.vault.on("rename", (file, oldPath) => {
				void this.handleVaultRename(file, oldPath);
			}),
		);
		this.startFolderSnapshotWatch();
		this.startConfigSnapshotWatch();
		void this.openActiveFile();
	}

	async openActiveFile(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const view = this.host.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view?.file || view.getMode() !== "source") {
			return;
		}
		await this.openEditor(view.file, view.editor);
	}

	async handleEditorChange(
		editor: Editor,
		info: MarkdownView | MarkdownFileInfo,
	): Promise<void> {
		const file = info.file;
		if (!file || !isTextSyncFile(file) || this.disposed) {
			return;
		}
		const path = normalizePath(file.path);
		if (this.suppressPathEvents.has(path)) {
			return;
		}
		this.cancelPendingModify(path);

		const binding = await this.openEditor(file, editor);
		if (!binding || binding.editor !== editor || binding.adapter.isApplyingRemote()) {
			return;
		}
		this.scheduleOpenEditorReconcile(binding);
	}

	async handleVaultCreate(file: TAbstractFile): Promise<void> {
		const path = normalizePath(file.path);
		if (this.shouldIgnoreVaultEventPath(path)) {
			return;
		}
		this.scheduleFolderStateSync();
		if (file instanceof TFolder) {
			this.host.setStatus(`Convex sync: folder created ${path}`);
			return;
		}
		if (!(file instanceof TFile) || !isTextSyncFile(file) || this.disposed) {
			return;
		}
		if (this.suppressPathEvents.has(path)) {
			return;
		}
		const text = await this.host.app.vault.cachedRead(file);
		await this.reconcileClosedFile(path, text, file);
		this.host.setStatus(`Convex sync: created ${file.basename}`);
	}

	async handleVaultModify(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || !isTextSyncFile(file) || this.disposed) {
			return;
		}
		const path = normalizePath(file.path);
		if (this.suppressPathEvents.has(path)) {
			return;
		}
		if (this.isCurrentOpenPath(path)) {
			this.cancelPendingModify(path);
			return;
		}
		const existingTimer = this.pendingModifyTimers.get(path);
		if (existingTimer !== undefined) {
			clearLiveSyncTimeout(existingTimer);
		}
		const timer = setLiveSyncTimeout(() => {
			this.pendingModifyTimers.delete(path);
			void this.syncModifiedFile(file);
		}, 250);
		this.pendingModifyTimers.set(path, timer);
	}

	async handleVaultDelete(file: TAbstractFile): Promise<void> {
		const path = normalizePath(file.path);
		if (this.shouldIgnoreVaultEventPath(path)) {
			return;
		}
		this.scheduleFolderStateSync();
		if (file instanceof TFolder) {
			this.host.setStatus(`Convex sync: folder deleted ${path}`);
			return;
		}
		if (!(file instanceof TFile) || !isTextSyncFile(file) || this.disposed) {
			return;
		}
		if (this.suppressPathEvents.has(path)) {
			return;
		}
		const engine = await this.getEngine();
		if (!engine) {
			return;
		}
		if (this.current?.file.path === path) {
			this.current.session.close();
			this.current = null;
		}
		await engine.deletePath(path);
		await this.removeSnapshotPath(path);
		this.host.setStatus(`Convex sync: deleted ${file.basename}`);
	}

	async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
		const normalizedOldPath = normalizePath(oldPath);
		const newPath = normalizePath(file.path);
		if (
			this.shouldIgnoreVaultEventPath(normalizedOldPath) &&
			this.shouldIgnoreVaultEventPath(newPath)
		) {
			return;
		}
		this.scheduleFolderStateSync();
		if (file instanceof TFolder) {
			this.host.setStatus(`Convex sync: folder renamed ${newPath}`);
			return;
		}
		if (!(file instanceof TFile) || !isTextSyncFile(file) || this.disposed) {
			return;
		}
		if (
			this.suppressPathEvents.has(normalizedOldPath) ||
			this.suppressPathEvents.has(newPath)
		) {
			return;
		}
		const engine = await this.getEngine();
		if (!engine) {
			return;
		}
		await engine.renamePath(normalizedOldPath, newPath);
		await this.removeSnapshotPath(normalizedOldPath);
		const text = await this.host.app.vault.cachedRead(file);
		await this.reconcileClosedFile(newPath, text, file);
		this.host.setStatus(`Convex sync: renamed ${file.basename}`);
	}

	async dispose(): Promise<void> {
		if (this.disposing) {
			await this.disposing;
			return;
		}
		this.disposing = this.doDispose();
		await this.disposing;
	}

	private async doDispose(): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.pathChangesUnsubscribe?.();
		this.pathChangesUnsubscribe = null;
		this.folderSnapshotUnsubscribe?.();
		this.folderSnapshotUnsubscribe = null;
		this.configSnapshotUnsubscribe?.();
		this.configSnapshotUnsubscribe = null;
		for (const ref of this.workspaceRefs.splice(0)) {
			this.host.app.workspace.offref(ref);
		}
		for (const ref of this.vaultRefs.splice(0)) {
			this.host.app.vault.offref(ref);
		}
		for (const timer of this.pendingModifyTimers.values()) {
			clearLiveSyncTimeout(timer);
		}
		this.pendingModifyTimers.clear();
		if (this.folderSyncTimer !== null) {
			clearLiveSyncTimeout(this.folderSyncTimer);
			this.folderSyncTimer = null;
		}
		if (this.configSnapshotTimer !== null) {
			clearLiveSyncTimeout(this.configSnapshotTimer);
			this.configSnapshotTimer = null;
		}
		if (this.editorChangeTimer !== null) {
			clearLiveSyncTimeout(this.editorChangeTimer);
			this.editorChangeTimer = null;
		}
		this.current?.session.close();
		this.current = null;
		const engine =
			this.engine ?? (await this.engineBoot?.catch(() => null)) ?? null;
		await engine?.dispose();
		this.engine = null;
		this.engineBoot = null;
	}

	private async openEditor(
		file: TFile,
		editor: Editor,
	): Promise<OpenEditorBinding | null> {
		if (!isTextSyncFile(file) || this.disposed) {
			return null;
		}
		const path = normalizePath(file.path);
		if (this.current?.file.path === path && this.current.editor === editor) {
			return this.current;
		}

		const existingOpen = this.openingByPath.get(path);
		if (existingOpen) {
			return existingOpen;
		}

		const opening = this.doOpenEditor(file, editor).finally(() => {
			this.openingByPath.delete(path);
		});
		this.openingByPath.set(path, opening);
		return opening;
	}

	private async doOpenEditor(
		file: TFile,
		editor: Editor,
	): Promise<OpenEditorBinding | null> {
		const engine = await this.getEngine();
		if (!engine || this.disposed) {
			return null;
		}

		const path = normalizePath(file.path);
		const previous = this.current;
		const openingDifferentPathInSameEditor =
			previous?.editor === editor && normalizePath(previous.file.path) !== path;
		this.current?.session.close();
		let binding: OpenEditorBinding | null = null;
		const session = await engine.openDoc(path, {
			onRemotePatch: () => {
				if (binding) {
					void this.reconcileOpenEditor(binding);
				}
			},
		});
		const adapter = createEditorAdapter(session);
		binding = { file, editor, session, adapter };
		this.current = binding;
		const initialLocalText = openingDifferentPathInSameEditor
			? await this.host.app.vault.cachedRead(file)
			: undefined;
		await this.reconcileOpenEditor(binding, initialLocalText);
		this.host.setStatus(`Convex sync: live ${file.basename}`);
		return binding;
	}

	private async getEngine(): Promise<SyncEngine | null> {
		if (this.engine) {
			return this.engine;
		}
		if (this.engineBoot) {
			return this.engineBoot;
		}

		this.engineBoot = this.bootEngine();
		return this.engineBoot;
	}

	private async bootEngine(): Promise<SyncEngine | null> {
		const client = this.host.getRealtimeClient();
		const convexSecret = this.host.settings.convexSecret.trim();
		if (!client || convexSecret.length === 0) {
			this.host.setStatus("Convex sync: not configured");
			return null;
		}
		try {
			const engine = await SyncEngine.boot({
				vaultId: this.host.app.vault.getName(),
				convexClient: client,
				convexSecret,
			});
			if (this.disposed) {
				await engine.dispose();
				return null;
			}
			this.engine = engine;
			this.pathChangesUnsubscribe = this.engine.watchPathChanges((changes) => {
				void this.applyRemotePathChanges(changes);
			});
			await this.applyRemotePathChanges(await this.engine.listRemotePathChanges());
			this.host.setStatus("Convex sync: live");
			return this.engine;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.host.setStatus("Convex sync: failed");
			new Notice(`Convex live sync failed: ${message}`, 10000);
			console.error(error);
			return null;
		}
	}

	private startFolderSnapshotWatch(): void {
		const client = this.host.getRealtimeClient();
		const convexSecret = this.host.settings.convexSecret.trim();
		if (!client || convexSecret.length === 0 || this.folderSnapshotUnsubscribe) {
			return;
		}
		if (typeof client.onUpdate !== "function") {
			return;
		}
		this.folderSnapshotUnsubscribe = client.onUpdate(
			api.fileSync.listFolderSnapshot,
			{ convexSecret },
			(rows) => {
				void this.applyRemoteFolderSnapshot(rows as FolderSnapshotRow[]);
			},
		);
	}

	private startConfigSnapshotWatch(): void {
		const client = this.host.getRealtimeClient();
		const fileSyncClient = this.host.getFileSyncClient?.() ?? null;
		const convexSecret = this.host.settings.convexSecret.trim();
		if (
			!client ||
			!fileSyncClient ||
			convexSecret.length === 0 ||
			this.configSnapshotUnsubscribe
		) {
			return;
		}
		if (typeof client.onUpdate !== "function") {
			return;
		}
		this.configSnapshotUnsubscribe = client.onUpdate(
			api.fileSync.listSnapshot,
			{ convexSecret },
			(snapshot) => {
				this.handleConfigSnapshot(snapshot as Snapshot);
			},
		);
	}

	private handleConfigSnapshot(snapshot: Snapshot): void {
		if (this.disposed) {
			return;
		}
		const signature = configSnapshotSignature(snapshot);
		if (this.lastConfigSnapshotSignature === null) {
			this.lastConfigSnapshotSignature = signature;
			return;
		}
		if (signature === this.lastConfigSnapshotSignature) {
			return;
		}
		this.lastConfigSnapshotSignature = signature;
		this.latestConfigSnapshot = snapshot;
		if (this.configSnapshotTimer !== null) {
			clearLiveSyncTimeout(this.configSnapshotTimer);
		}
		this.configSnapshotTimer = setLiveSyncTimeout(() => {
			this.configSnapshotTimer = null;
			const latest = this.latestConfigSnapshot;
			this.latestConfigSnapshot = null;
			if (latest) {
				void this.applyRemoteConfigSnapshot(latest);
			}
		}, 750);
	}

	private async applyRemoteConfigSnapshot(snapshot: Snapshot): Promise<void> {
		const client = this.host.getFileSyncClient?.() ?? null;
		const convexSecret = this.host.settings.convexSecret.trim();
		if (!client || convexSecret.length === 0 || this.disposed) {
			return;
		}
		try {
			const result = await applyDotObsidianSnapshot(
				{
					app: this.host.app,
					settings: this.host.settings,
					getConvexHttpClient: () => client,
				},
				snapshot,
			);
			const changed =
				result.filesDownloaded > 0 ||
				result.localFilesDeleted > 0 ||
				result.foldersSynced > 0;
			if (changed) {
				this.host.setStatus("Convex sync: .obsidian updated");
				showConfigRestartNotice();
			}
		} catch (error) {
			console.warn("[live-sync] .obsidian config pull skipped", {
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private scheduleFolderStateSync(): void {
		if (this.disposed) {
			return;
		}
		if (this.folderSyncTimer !== null) {
			clearLiveSyncTimeout(this.folderSyncTimer);
		}
		this.folderSyncTimer = setLiveSyncTimeout(() => {
			this.folderSyncTimer = null;
			void this.publishFolderState();
		}, FOLDER_SYNC_DEBOUNCE_MS);
	}

	private async publishFolderState(): Promise<void> {
		const client = this.host.getFileSyncClient?.() ?? null;
		const convexSecret = this.host.settings.convexSecret.trim();
		const clientId = this.host.getPresenceSessionId?.() ?? "";
		if (!client || convexSecret.length === 0 || clientId.length === 0 || this.disposed) {
			return;
		}
		try {
			const localState = await listLocalEntries({ app: this.host.app } as never);
			const folderPaths = localState.folders.filter(
				(path) => normalizePath(path).trim() !== "",
			);
			const emptyFolderPaths = localState.emptyFolders.filter(
				(path) => normalizePath(path).trim() !== "",
			);
			await client.mutation(api.fileSync.syncFolderState, {
				convexSecret,
				scannedAtMs: Date.now(),
				clientId,
				folderPaths,
				emptyFolderPaths,
			});
			this.host.setStatus("Convex sync: folders synced");
		} catch (error) {
			console.warn("[live-sync] folder state sync skipped", {
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async applyRemoteFolderSnapshot(
		rows: FolderSnapshotRow[],
	): Promise<void> {
		if (this.disposed) {
			return;
		}
		const next = new Map<string, FolderSnapshotRow>();
		for (const row of rows) {
			const path = normalizePath(row.path);
			if (path.trim() === "" || shouldIgnoreVaultPath(path)) {
				continue;
			}
			next.set(path, { ...row, path });
		}

		const previous = this.remoteFolders;
		this.remoteFolders = next;

		for (const row of next.values()) {
			if (row.isExplicitlyEmpty) {
				await this.applyRemoteFolderCreate(row.path);
			}
		}
		if (!previous) {
			return;
		}
		for (const path of previous.keys()) {
			if (!next.has(path)) {
				await this.applyRemoteFolderDelete(path);
			}
		}
	}

	private async applyRemoteFolderCreate(path: string): Promise<void> {
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) {
			return;
		}
		const suppressedPaths = folderAncestry(path);
		for (const suppressedPath of suppressedPaths) {
			this.suppressPathEvents.add(suppressedPath);
		}
		try {
			await ensureVaultFolderExists(this.host.app, path);
			this.host.setStatus(`Convex sync: folder created ${path}`);
		} finally {
			queueMicrotask(() => {
				for (const suppressedPath of suppressedPaths) {
					this.suppressPathEvents.delete(suppressedPath);
				}
			});
		}
	}

	private async applyRemoteFolderDelete(path: string): Promise<void> {
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		if (!(existing instanceof TFolder) || !isEmptySyncedFolder(existing)) {
			return;
		}
		this.suppressPathEvents.add(path);
		try {
			await this.host.app.vault.delete(existing);
			this.host.setStatus(`Convex sync: folder deleted ${path}`);
		} finally {
			queueMicrotask(() => {
				this.suppressPathEvents.delete(path);
			});
		}
	}

	private async reconcileOpenEditor(
		binding: OpenEditorBinding,
		localTextOverride?: string,
	): Promise<void> {
		if (this.disposed || this.current !== binding || binding.adapter.isApplyingRemote()) {
			return;
		}
		const engine = await this.getEngine();
		if (!engine || this.current !== binding) {
			return;
		}
		const editorTextAtStart = binding.editor.getValue();
		const localText = localTextOverride ?? editorTextAtStart;
		const result = await engine.reconcilePath(binding.file.path, localText);
		if (this.current !== binding || binding.editor.getValue() !== editorTextAtStart) {
			return;
		}
		this.applyRemoteText(binding.editor, result.text, binding.adapter);
		await this.mirrorTextSnapshot(binding.file.path, result.text);
	}

	private scheduleOpenEditorReconcile(binding: OpenEditorBinding): void {
		if (this.editorChangeTimer !== null) {
			clearLiveSyncTimeout(this.editorChangeTimer);
		}
		this.editorChangeTimer = setLiveSyncTimeout(() => {
			this.editorChangeTimer = null;
			void this.reconcileOpenEditor(binding)
				.then(() => {
					if (!this.disposed && this.current === binding) {
						this.host.setStatus(`Convex sync: synced ${binding.file.basename}`);
					}
				})
				.catch((error: unknown) => {
					console.warn("[live-sync] editor reconcile skipped", {
						path: binding.file.path,
						message: error instanceof Error ? error.message : String(error),
					});
				});
		}, EDITOR_CHANGE_DEBOUNCE_MS);
	}

	private async reconcileClosedFile(
		path: string,
		localText: string,
		file: TFile | null,
		options: {
			preferRemoteOnMissingBase?: boolean;
			mirrorSnapshot?: boolean;
		} = {},
	): Promise<void> {
		const engine = await this.getEngine();
		if (!engine || this.disposed) {
			return;
		}
		const result = await engine.reconcilePath(path, localText, {
			preferRemoteOnMissingBase: options.preferRemoteOnMissingBase,
		});
		if (file === null || result.text !== localText) {
			await this.writePathText(path, result.text);
		}
		if (options.mirrorSnapshot ?? true) {
			await this.mirrorTextSnapshot(path, result.text);
		}
	}

	private async syncModifiedFile(file: TFile): Promise<void> {
		const path = normalizePath(file.path);
		if (this.suppressPathEvents.has(path) || this.isCurrentOpenPath(path)) {
			return;
		}
		const text = await this.host.app.vault.read(file);
		await this.reconcileClosedFile(path, text, file);
		this.host.setStatus(`Convex sync: modified ${file.basename}`);
	}

	private applyRemoteText(
		editor: Editor,
		text: string,
		adapter: EditorAdapter | null,
	): void {
		if (adapter) {
			adapter.applyRemoteText(editor, text);
		} else if (editor.getValue() !== text) {
			editor.setValue(text);
		}
	}

	private async applyRemotePathChanges(changes: DocPathChange[]): Promise<void> {
		for (const change of changes) {
			const path = normalizePath(change.path);
			if (isMergeBackupPath(path)) {
				continue;
			}
			if (change.deletedAtMs !== null) {
				await this.applyRemoteDelete(path);
			} else {
				await this.applyRemoteCreateOrUpdate(change);
			}
		}
	}

	private async applyRemoteDelete(path: string): Promise<void> {
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		if (!(existing instanceof TFile) || !isTextSyncFile(existing)) {
			return;
		}
		this.suppressPathEvents.add(path);
		try {
			if (this.current?.file.path === path) {
				this.current.session.close();
				this.current = null;
			}
			await this.host.app.vault.delete(existing);
			this.host.setStatus(`Convex sync: deleted ${existing.basename}`);
		} finally {
			queueMicrotask(() => {
				this.suppressPathEvents.delete(path);
			});
		}
	}

	private async applyRemoteCreateOrUpdate(change: DocPathChange): Promise<void> {
		const engine = await this.getEngine();
		if (!engine || this.disposed) {
			return;
		}
		const path = normalizePath(change.path);
		const existingLocalPath = await engine.getLocalPathForDocId(change.docId);
		if (existingLocalPath && existingLocalPath !== path) {
			await this.applyRemoteRename(existingLocalPath, path, change.docId);
		} else {
			await engine.bindRemotePath(change.docId, path);
		}
		if (this.isCurrentOpenPath(path, change.docId)) {
			if (change.updatedByClientId === engine.getClientId() && this.current) {
				await this.mirrorTextSnapshot(path, this.current.editor.getValue());
			}
			return;
		}
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		const file = existing instanceof TFile && isTextSyncFile(existing) ? existing : null;
		const localText = file ? await this.host.app.vault.cachedRead(file) : "";
		const isPeerUpdate = change.updatedByClientId !== engine.getClientId();
		await this.reconcileClosedFile(path, localText, file, {
			preferRemoteOnMissingBase: isPeerUpdate,
			mirrorSnapshot: !isPeerUpdate,
		});
		if (isPeerUpdate) {
			await this.recoverFromRemoteSnapshot(path);
		}
	}

	private async applyRemoteRename(
		oldPath: string,
		newPath: string,
		docId: string,
	): Promise<void> {
		const oldFile = this.host.app.vault.getAbstractFileByPath(oldPath);
		const newFile = this.host.app.vault.getAbstractFileByPath(newPath);
		const engine = await this.getEngine();
		if (!engine) {
			return;
		}

		if (!(oldFile instanceof TFile) || !isTextSyncFile(oldFile)) {
			await engine.bindRemotePath(docId, newPath);
			return;
		}

		this.suppressPathEvents.add(oldPath);
		this.suppressPathEvents.add(newPath);
		try {
			if (!newFile) {
				await ensureVaultFolderExists(this.host.app, folderPathForFile(newPath));
				await this.host.app.vault.rename(oldFile, newPath);
			} else if (newFile instanceof TFile && isTextSyncFile(newFile)) {
				const [oldText, newText] = await Promise.all([
					this.host.app.vault.cachedRead(oldFile),
					this.host.app.vault.cachedRead(newFile),
				]);
				if (oldText === newText) {
					await this.host.app.vault.delete(oldFile);
				}
			}
			await engine.bindRemotePath(docId, newPath);
			await this.removeSnapshotPath(oldPath);
			this.host.setStatus(`Convex sync: renamed ${newPath}`);
		} finally {
			queueMicrotask(() => {
				this.suppressPathEvents.delete(oldPath);
				this.suppressPathEvents.delete(newPath);
			});
		}
	}

	private async writePathText(path: string, text: string): Promise<void> {
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		this.suppressPathEvents.add(path);
		try {
			if (existing instanceof TFile) {
				if (isTextSyncFile(existing)) {
					const current = await this.host.app.vault.cachedRead(existing);
					if (current !== text) {
						await this.host.app.vault.modify(existing, text);
					}
				}
				return;
			}
			await ensureVaultFolderExists(this.host.app, folderPathForFile(path));
			try {
				await this.host.app.vault.create(path, text);
			} catch (error) {
				const racedFile = this.host.app.vault.getAbstractFileByPath(path);
				if (!(racedFile instanceof TFile)) {
					throw error;
				}
				const current = await this.host.app.vault.cachedRead(racedFile);
				if (current !== text) {
					await this.host.app.vault.modify(racedFile, text);
				}
			}
		} finally {
			queueMicrotask(() => {
				this.suppressPathEvents.delete(path);
			});
		}
	}

	private async recoverFromRemoteSnapshot(path: string): Promise<void> {
		const client = this.host.getFileSyncClient?.() ?? null;
		const convexSecret = this.host.settings.convexSecret.trim();
		if (!client || convexSecret.length === 0 || this.disposed) {
			return;
		}
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		if (!(existing instanceof TFile) || !isTextSyncFile(existing)) {
			return;
		}
		const localText = await this.host.app.vault.cachedRead(existing);
		const remote = await readRemoteFileBytes(client, convexSecret, path);
		if (!remote) {
			return;
		}
		const remoteText = new TextDecoder().decode(remote.bytes);
		if (remoteText === localText) {
			return;
		}
		console.info("[live-sync] recovering text from vaultFiles snapshot", {
			path,
			localLength: localText.length,
			remoteLength: remoteText.length,
		});
		const engine = await this.getEngine();
		if (!engine || this.disposed) {
			return;
		}
		const result = await engine.reconcilePath(path, remoteText);
		if (result.text !== localText) {
			await this.writePathText(path, result.text);
		}
	}

	private async mirrorTextSnapshot(path: string, text: string): Promise<void> {
		const client = this.host.getFileSyncClient?.() ?? null;
		const clientId = this.host.getPresenceSessionId?.() ?? "";
		const convexSecret = this.host.settings.convexSecret.trim();
		if (!client || convexSecret.length === 0 || clientId.length === 0 || this.disposed) {
			return;
		}
		const encoded = new TextEncoder().encode(text);
		try {
			await uploadLocalFile(
				client,
				convexSecret,
				clientId,
				normalizePath(path),
				encoded.buffer.slice(
					encoded.byteOffset,
					encoded.byteOffset + encoded.byteLength,
				) as ArrayBuffer,
				Date.now(),
				{ force: true },
			);
		} catch (error) {
			console.warn("[live-sync] vaultFiles mirror skipped", {
				path,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async removeSnapshotPath(path: string): Promise<void> {
		const client = this.host.getFileSyncClient?.() ?? null;
		const convexSecret = this.host.settings.convexSecret.trim();
		if (!client || convexSecret.length === 0 || this.disposed) {
			return;
		}
		try {
			await client.mutation(api.fileSync.removeFilesByPath, {
				convexSecret,
				removedPaths: [normalizePath(path)],
			});
		} catch (error) {
			console.warn("[live-sync] vaultFiles delete skipped", {
				path,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private cancelPendingModify(path: string): void {
		const timer = this.pendingModifyTimers.get(path);
		if (timer === undefined) {
			return;
		}
		clearLiveSyncTimeout(timer);
		this.pendingModifyTimers.delete(path);
	}

	private isCurrentOpenPath(path: string, docId?: string): boolean {
		if (!this.current || normalizePath(this.current.file.path) !== path) {
			return false;
		}
		return docId === undefined || this.current.session.docId === docId;
	}

	private shouldIgnoreVaultEventPath(path: string): boolean {
		return (
			this.disposed ||
			path.trim() === "" ||
			shouldIgnoreVaultPath(path) ||
			this.suppressPathEvents.has(path)
		);
	}
}

function isEmptySyncedFolder(folder: TFolder): boolean {
	return folder.children.every((child) =>
		shouldIgnoreVaultPath(normalizePath(child.path)),
	);
}

function folderAncestry(path: string): string[] {
	const normalized = normalizePath(path);
	const parts = normalized.split("/").filter(Boolean);
	const paths: string[] = [];
	for (let index = 0; index < parts.length; index += 1) {
		paths.push(parts.slice(0, index + 1).join("/"));
	}
	return paths;
}

function setLiveSyncTimeout(callback: () => void, delayMs: number): number {
	return globalThis.setTimeout(callback, delayMs) as unknown as number;
}

function clearLiveSyncTimeout(timer: number): void {
	globalThis.clearTimeout(timer);
}

function configSnapshotSignature(snapshot: Snapshot): string {
	const files = snapshot.files
		.filter((file) => isSyncedDotObsidianPath(file.path))
		.map(
			(file) =>
				`f:${normalizePath(file.path)}:${file.contentHash}:${file.updatedAtMs}:${file.updatedByClientId}`,
		);
	const folders = snapshot.folders
		.filter((folder) => isSyncedDotObsidianPath(folder.path))
		.map(
			(folder) =>
				`d:${normalizePath(folder.path)}:${folder.updatedAtMs}:${folder.isExplicitlyEmpty}:${folder.updatedByClientId}`,
		);
	return [...files, ...folders].sort().join("\n");
}

function isSyncedDotObsidianPath(path: string): boolean {
	const normalized = normalizePath(path);
	return isDotObsidianPath(normalized) && !shouldIgnoreVaultPath(normalized);
}
