import {
	MarkdownView,
	Notice,
	TAbstractFile,
	TFile,
	normalizePath,
	type App,
	type Editor,
	type EventRef,
	type MarkdownFileInfo,
} from "obsidian";
import type { ConvexClient } from "convex/browser";
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
import { folderPathForFile } from "../lib/path";

export type LiveSyncHost = {
	app: App;
	settings: MyPluginSettings;
	getRealtimeClient(): ConvexClient | null;
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
		await this.reconcileOpenEditor(binding);
		this.host.setStatus(`Convex sync: synced ${file.basename}`);
	}

	async handleVaultCreate(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || !isTextSyncFile(file) || this.disposed) {
			return;
		}
		const path = normalizePath(file.path);
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
			window.clearTimeout(existingTimer);
		}
		const timer = window.setTimeout(() => {
			this.pendingModifyTimers.delete(path);
			void this.syncModifiedFile(file);
		}, 250);
		this.pendingModifyTimers.set(path, timer);
	}

	async handleVaultDelete(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || !isTextSyncFile(file) || this.disposed) {
			return;
		}
		const path = normalizePath(file.path);
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
		this.host.setStatus(`Convex sync: deleted ${file.basename}`);
	}

	async handleVaultRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (!(file instanceof TFile) || !isTextSyncFile(file) || this.disposed) {
			return;
		}
		const normalizedOldPath = normalizePath(oldPath);
		const newPath = normalizePath(file.path);
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
		for (const ref of this.workspaceRefs.splice(0)) {
			this.host.app.workspace.offref(ref);
		}
		for (const ref of this.vaultRefs.splice(0)) {
			this.host.app.vault.offref(ref);
		}
		for (const timer of this.pendingModifyTimers.values()) {
			window.clearTimeout(timer);
		}
		this.pendingModifyTimers.clear();
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

		this.current?.session.close();
		let binding: OpenEditorBinding | null = null;
		const session = await engine.openDoc(file.path, {
			onRemotePatch: () => {
				if (binding) {
					void this.reconcileOpenEditor(binding);
				}
			},
		});
		const adapter = createEditorAdapter(session);
		binding = { file, editor, session, adapter };
		this.current = binding;
		await this.reconcileOpenEditor(binding);
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

	private async reconcileOpenEditor(binding: OpenEditorBinding): Promise<void> {
		if (this.disposed || this.current !== binding || binding.adapter.isApplyingRemote()) {
			return;
		}
		const engine = await this.getEngine();
		if (!engine || this.current !== binding) {
			return;
		}
		const localText = binding.editor.getValue();
		const result = await engine.reconcilePath(binding.file.path, localText, {
			onBeforeFallbackMerge: async () => {
				await this.createMergeBackup(binding.file, localText);
			},
		});
		if (this.current !== binding || binding.editor.getValue() !== localText) {
			return;
		}
		this.applyRemoteText(binding.editor, result.text, binding.adapter);
	}

	private async reconcileClosedFile(
		path: string,
		localText: string,
		file: TFile | null,
	): Promise<void> {
		const engine = await this.getEngine();
		if (!engine || this.disposed) {
			return;
		}
		const result = await engine.reconcilePath(path, localText, {
			onBeforeFallbackMerge: async () => {
				if (file) {
					await this.createMergeBackup(file, localText);
				}
			},
		});
		if (result.text !== localText) {
			await this.writePathText(path, result.text);
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
			return;
		}
		const existing = this.host.app.vault.getAbstractFileByPath(path);
		const file = existing instanceof TFile && isTextSyncFile(existing) ? existing : null;
		const localText = file ? await this.host.app.vault.cachedRead(file) : "";
		await this.reconcileClosedFile(path, localText, file);
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

	private async createMergeBackup(file: TFile, text: string): Promise<void> {
		const backupPath = nextBackupPath(file.path, new Date());
		let candidatePath = backupPath;
		this.suppressPathEvents.add(candidatePath);
		try {
			await ensureVaultFolderExists(this.host.app, folderPathForFile(backupPath));
			let attempt = 1;
			while (this.host.app.vault.getAbstractFileByPath(candidatePath)) {
				this.suppressPathEvents.delete(candidatePath);
				candidatePath = appendBackupSuffix(backupPath, attempt);
				this.suppressPathEvents.add(candidatePath);
				attempt += 1;
			}
			await this.host.app.vault.create(candidatePath, text);
		} finally {
			queueMicrotask(() => {
				this.suppressPathEvents.delete(candidatePath);
			});
		}
	}

	private cancelPendingModify(path: string): void {
		const timer = this.pendingModifyTimers.get(path);
		if (timer === undefined) {
			return;
		}
		window.clearTimeout(timer);
		this.pendingModifyTimers.delete(path);
	}

	private isCurrentOpenPath(path: string, docId?: string): boolean {
		if (!this.current || normalizePath(this.current.file.path) !== path) {
			return false;
		}
		return docId === undefined || this.current.session.docId === docId;
	}
}

function nextBackupPath(path: string, now: Date): string {
	const timestamp = [
		now.getFullYear(),
		pad(now.getMonth() + 1),
		pad(now.getDate()),
	].join("") + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const extensionIndex = path.lastIndexOf(".");
	if (extensionIndex <= 0) {
		return `${path}.convex-merge-backup-${timestamp}.md`;
	}
	const stem = path.slice(0, extensionIndex);
	const extension = path.slice(extensionIndex);
	return `${stem}.convex-merge-backup-${timestamp}${extension}`;
}

function appendBackupSuffix(path: string, attempt: number): string {
	const extensionIndex = path.lastIndexOf(".");
	if (extensionIndex <= 0) {
		return `${path}-${attempt}`;
	}
	return `${path.slice(0, extensionIndex)}-${attempt}${path.slice(extensionIndex)}`;
}

function pad(value: number): string {
	return value.toString().padStart(2, "0");
}
