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
import type { ConvexClient } from "convex/browser";
import type { MyPluginSettings } from "../settings";
import {
	SyncEngine,
	type OpenDocumentSession,
	type OpenDocOptions,
} from "../core/sync-engine";
import { createEditorAdapter, type EditorAdapter } from "./editor-adapter";
import type { DocPathChange } from "../transport/convex-client";

export type LiveSyncHost = {
	app: App;
	settings: MyPluginSettings;
	getRealtimeClient(): ConvexClient | null;
	registerEvent(ref: EventRef): void;
	register(cleanup: () => void): void;
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
	host.registerEvent(
		host.app.workspace.on("file-open", () => {
			void controller.openActiveFile();
		}),
	);
	host.registerEvent(
		host.app.workspace.on("editor-change", (editor, info) => {
			void controller.handleEditorChange(editor, info);
		}),
	);
	host.registerEvent(
		host.app.vault.on("create", (file) => {
			void controller.handleVaultCreate(file);
		}),
	);
	host.registerEvent(
		host.app.vault.on("modify", (file) => {
			void controller.handleVaultModify(file);
		}),
	);
	host.registerEvent(
		host.app.vault.on("delete", (file) => {
			void controller.handleVaultDelete(file);
		}),
	);
	host.registerEvent(
		host.app.vault.on("rename", (file, oldPath) => {
			void controller.handleVaultRename(file, oldPath);
		}),
	);
	host.register(() => {
		void controller.dispose();
	});
	void controller.openActiveFile();
	return controller;
}

class ObsidianLiveSyncController implements LiveSyncController {
	private engine: SyncEngine | null = null;
	private engineBoot: Promise<SyncEngine | null> | null = null;
	private current: OpenEditorBinding | null = null;
	private readonly openingByPath = new Map<string, Promise<OpenEditorBinding | null>>();
	private readonly suppressPathEvents = new Set<string>();
	private readonly pendingModifyTimers = new Map<string, number>();
	private pathChangesUnsubscribe: (() => void) | null = null;

	constructor(private readonly host: LiveSyncHost) {}

	async openActiveFile(): Promise<void> {
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
		if (!file || !isTextSyncFile(file)) {
			return;
		}
		const path = normalizePath(file.path);
		if (this.suppressPathEvents.has(path)) {
			return;
		}
		this.cancelPendingModify(path);

		const binding = await this.openEditor(file, editor);
		if (!binding || binding.editor !== editor) {
			return;
		}
		await binding.adapter.handleEditorChange(editor);
		this.host.setStatus(`Convex sync: synced ${file.basename}`);
	}

	async handleVaultCreate(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || !isTextSyncFile(file)) {
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
		const text = await this.host.app.vault.cachedRead(file);
		await engine.syncFileText(path, text);
		this.host.setStatus(`Convex sync: created ${file.basename}`);
	}

	async handleVaultModify(file: TAbstractFile): Promise<void> {
		if (!(file instanceof TFile) || !isTextSyncFile(file)) {
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
		if (!(file instanceof TFile) || !isTextSyncFile(file)) {
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
		if (!(file instanceof TFile) || !isTextSyncFile(file)) {
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
		await engine.syncFileText(newPath, text);
		this.host.setStatus(`Convex sync: renamed ${file.basename}`);
	}

	async dispose(): Promise<void> {
		this.pathChangesUnsubscribe?.();
		this.pathChangesUnsubscribe = null;
		for (const timer of this.pendingModifyTimers.values()) {
			window.clearTimeout(timer);
		}
		this.pendingModifyTimers.clear();
		this.current?.session.close();
		this.current = null;
		await this.engine?.dispose();
		this.engine = null;
	}

	private async openEditor(
		file: TFile,
		editor: Editor,
	): Promise<OpenEditorBinding | null> {
		if (!isTextSyncFile(file)) {
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
		if (!engine) {
			return null;
		}

		this.current?.session.close();
		let adapter: EditorAdapter | null = null;
		const session = await engine.openDoc(file.path, {
			onInitialState: (text) => {
				if (text.length > 0) {
					this.applyRemoteText(file, editor, text, adapter);
				}
			},
			onRemotePatch: (text) => {
				this.applyRemoteText(file, editor, text, adapter);
			},
		});
		adapter = createEditorAdapter(session);
		const binding = { file, editor, session, adapter };
		this.current = binding;

		const localText = editor.getValue();
		const crdtText = session.getTextSnapshot();
		if (crdtText.length === 0 && localText.length > 0) {
			await session.applyLocalChange([{ pos: 0, del: 0, ins: localText }]);
		} else if (crdtText !== localText) {
			this.applyRemoteText(file, editor, crdtText, adapter);
		}

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
			this.engine = await SyncEngine.boot({
				vaultId: this.host.app.vault.getName(),
				convexClient: client,
				convexSecret,
			});
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

	private async syncModifiedFile(file: TFile): Promise<void> {
		const path = normalizePath(file.path);
		if (this.suppressPathEvents.has(path)) {
			return;
		}
		if (this.isCurrentOpenPath(path)) {
			return;
		}
		const engine = await this.getEngine();
		if (!engine) {
			return;
		}
		const text = await this.host.app.vault.read(file);
		await engine.syncFileText(path, text);
		this.host.setStatus(`Convex sync: modified ${file.basename}`);
	}

	private applyRemoteText(
		file: TFile,
		editor: Editor,
		text: string,
		adapter: EditorAdapter | null,
	): void {
		const path = normalizePath(file.path);
		if (adapter) {
			adapter.applyRemoteText(editor, text);
		} else if (editor.getValue() !== text) {
			editor.setValue(text);
		}
		void this.writeVaultCache(path, file, text);
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
		if (!engine) {
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
		const session = await engine.openDoc(path, this.remoteOpenOptions(path));
		const text = session.getTextSnapshot();
		session.close();
		await this.writePathText(path, text);
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
				await ensureFolderExists(this.host.app, folderPathForFile(newPath));
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

	private remoteOpenOptions(path: string): OpenDocOptions {
		return {
			onRemotePatch: (text) => {
				void this.writePathText(path, text);
			},
		};
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
			await ensureFolderExists(this.host.app, folderPathForFile(path));
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

	private async writeVaultCache(
		path: string,
		file: TFile,
		text: string,
	): Promise<void> {
		this.suppressPathEvents.add(path);
		try {
			const current = await this.host.app.vault.cachedRead(file);
			if (current !== text) {
				await this.host.app.vault.modify(file, text);
			}
		} finally {
			queueMicrotask(() => {
				this.suppressPathEvents.delete(path);
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

function isTextSyncFile(file: TFile): boolean {
	const extension = file.extension.toLowerCase();
	return extension === "md" || extension === "markdown" || extension === "txt";
}

function folderPathForFile(filePath: string): string | null {
	const slash = filePath.lastIndexOf("/");
	return slash < 0 ? null : filePath.slice(0, slash);
}

async function ensureFolderExists(app: App, path: string | null): Promise<void> {
	if (!path) {
		return;
	}
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) {
		return;
	}
	await ensureFolderExists(app, folderPathForFile(path));
	await app.vault.createFolder(path);
}
