import { beforeEach, describe, expect, test, vi } from "vitest";

const openDocMock = vi.fn();
const reconcilePathMock = vi.fn();
const engineDisposeMock = vi.fn();
const watchPathChangesMock = vi.fn(() => () => undefined);
const uploadLocalFileMock = vi.hoisted(() => vi.fn());

vi.mock("../core/sync-engine", () => ({
	SyncEngine: {
		boot: vi.fn(async () => ({
			openDoc: openDocMock,
			reconcilePath: reconcilePathMock,
			watchPathChanges: watchPathChangesMock,
			dispose: engineDisposeMock,
		})),
	},
}));

vi.mock("../file-sync/remote-transfer", () => ({
	uploadLocalFile: uploadLocalFileMock,
}));

vi.mock("obsidian", () => {
	class TAbstractFile {}
	class TFile extends TAbstractFile {
		basename: string;
		extension: string;
		stat = { mtime: 1 };
		constructor(public path: string) {
			super();
			this.basename = path.replace(/.*\//, "").replace(/\.[^.]+$/, "");
			this.extension = path.split(".").pop() ?? "";
		}
	}
	class TFolder extends TAbstractFile {
		constructor(
			public path: string,
			public children: TAbstractFile[] = [],
		) {
			super();
		}
	}
	class MarkdownView {
		constructor(
			public file: TFile,
			public editor: { getValue(): string; setValue(value: string): void },
		) {}
		getMode() {
			return "source";
		}
	}
	class Notice {
		constructor(_message: string, _timeout?: number) {}
	}
	return {
		TAbstractFile,
		TFile,
		TFolder,
		MarkdownView,
		Notice,
		normalizePath: (path: string) => path,
	};
});

import { MarkdownView, TFile, TFolder } from "obsidian";
import { startObsidianLiveSync } from "./live-sync";

const TFileCtor = TFile as unknown as { new (path: string): TFile };
const TFolderCtor = TFolder as unknown as {
	new (path: string, children?: Array<TFile | TFolder>): TFolder;
};
const MarkdownViewCtor = MarkdownView as unknown as {
	new (
		file: TFile,
		editor: { getValue(): string; setValue(value: string): void },
	): MarkdownView;
};

describe("startObsidianLiveSync", () => {
	beforeEach(() => {
		openDocMock.mockReset();
		reconcilePathMock.mockReset();
		engineDisposeMock.mockReset();
		watchPathChangesMock.mockReset();
		uploadLocalFileMock.mockReset();
		watchPathChangesMock.mockReturnValue(() => undefined);
	});

	test("active remote patch updates editor without vault modify", async () => {
		const editor = createEditor("local");
		const file = new TFileCtor("note.md");
		const app = createApp(new MarkdownViewCtor(file, editor), [[file.path, file]]);
		let remotePatch: () => void = () => undefined;
		openDocMock.mockImplementation(async (_path: string, options?: { onRemotePatch?: () => void }) => {
			remotePatch = options?.onRemotePatch ?? (() => undefined);
			return createSession();
		});
		reconcilePathMock
			.mockResolvedValueOnce({
				docId: "doc-1",
				path: file.path,
				text: "local",
				changed: false,
				usedFallbackBackup: false,
			})
			.mockResolvedValueOnce({
				docId: "doc-1",
				path: file.path,
				text: "remote text",
				changed: true,
				usedFallbackBackup: false,
			});

		const controller = startObsidianLiveSync({
			app: app as never,
			settings: { convexSecret: "secret" } as never,
			getRealtimeClient: () => ({}) as never,
			setStatus: () => undefined,
		});
		await vi.waitFor(() => expect(openDocMock).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(reconcilePathMock).toHaveBeenCalledTimes(1));

		remotePatch();
		await vi.waitFor(() => expect(reconcilePathMock).toHaveBeenCalledTimes(2));

		expect(app.vault.modify).not.toHaveBeenCalled();
		expect(editor.getValue()).toBe("remote text");
		await controller.dispose();
	});

	test("dispose removes controller-owned listeners before restart", async () => {
		const editor = createEditor("text");
		const file = new TFileCtor("note.md");
		const app = createApp(new MarkdownViewCtor(file, editor), [[file.path, file]]);
		openDocMock.mockResolvedValue(createSession());
		reconcilePathMock.mockResolvedValue({
			docId: "doc-1",
			path: file.path,
			text: "text",
			changed: false,
			usedFallbackBackup: false,
		});

		const first = startObsidianLiveSync({
			app: app as never,
			settings: { convexSecret: "secret" } as never,
			getRealtimeClient: () => ({}) as never,
			setStatus: () => undefined,
		});
		await flushPromises();
		expect(app.workspace.listenerCount("file-open")).toBe(1);
		expect(app.workspace.listenerCount("editor-change")).toBe(1);
		expect(app.vault.listenerCount("modify")).toBe(1);

		await first.dispose();
		expect(app.workspace.listenerCount("file-open")).toBe(0);
		expect(app.workspace.listenerCount("editor-change")).toBe(0);
		expect(app.vault.listenerCount("modify")).toBe(0);

		const second = startObsidianLiveSync({
			app: app as never,
			settings: { convexSecret: "secret" } as never,
			getRealtimeClient: () => ({}) as never,
			setStatus: () => undefined,
		});
		await flushPromises();
		expect(app.workspace.listenerCount("file-open")).toBe(1);
		expect(app.workspace.listenerCount("editor-change")).toBe(1);
		expect(app.vault.listenerCount("modify")).toBe(1);
		await second.dispose();
	});

	test("stale async reconcile does not overwrite newer editor text", async () => {
		const editor = createEditor("local");
		const file = new TFileCtor("note.md");
		const app = createApp(new MarkdownViewCtor(file, editor), [[file.path, file]]);
		openDocMock.mockResolvedValue(createSession());

		const firstReconcile = deferred<{
			docId: string;
			path: string;
			text: string;
			changed: boolean;
			usedFallbackBackup: boolean;
		}>();
		reconcilePathMock
			.mockImplementationOnce(() => firstReconcile.promise)
			.mockResolvedValueOnce({
				docId: "doc-1",
				path: file.path,
				text: "local newer",
				changed: false,
				usedFallbackBackup: false,
			});

		const controller = startObsidianLiveSync({
			app: app as never,
			settings: { convexSecret: "secret" } as never,
			getRealtimeClient: () => ({}) as never,
			setStatus: () => undefined,
		});
		await vi.waitFor(() => expect(openDocMock).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(reconcilePathMock).toHaveBeenCalledTimes(1));

		editor.setValue("local newer");
		app.workspace.emit("editor-change", editor, { file });
		await vi.waitFor(() => expect(reconcilePathMock).toHaveBeenCalledTimes(2));

		firstReconcile.resolve({
			docId: "doc-1",
			path: file.path,
			text: "remote older",
			changed: true,
			usedFallbackBackup: false,
		});
		await flushPromises();

		expect(editor.getValue()).toBe("local newer");
		await controller.dispose();
	});

	test("same-editor file switch reconciles the newly opened file from vault text", async () => {
		const editor = createEditor("note A text");
		const fileA = new TFileCtor("a.md");
		const fileB = new TFileCtor("b.md");
		const view = new MarkdownViewCtor(fileA, editor);
		const app = createApp(
			view,
			[
				[fileA.path, fileA],
				[fileB.path, fileB],
			],
			new Map([
				[fileA.path, "note A text"],
				[fileB.path, "note B text"],
			]),
		);
		openDocMock.mockImplementation(async (path: string) =>
			createSession(`doc:${path}`, path),
		);
		reconcilePathMock
			.mockResolvedValueOnce({
				docId: "doc:a.md",
				path: fileA.path,
				text: "note A text",
				changed: false,
				usedFallbackBackup: false,
			})
			.mockResolvedValueOnce({
				docId: "doc:b.md",
				path: fileB.path,
				text: "note B text",
				changed: false,
				usedFallbackBackup: false,
			});

		const controller = startObsidianLiveSync({
			app: app as never,
			settings: { convexSecret: "secret" } as never,
			getRealtimeClient: () => ({}) as never,
			setStatus: () => undefined,
		});
		await vi.waitFor(() => expect(reconcilePathMock).toHaveBeenCalledTimes(1));

		view.file = fileB;
		app.workspace.emit("file-open");
		await vi.waitFor(() => expect(reconcilePathMock).toHaveBeenCalledTimes(2));

		expect(reconcilePathMock.mock.calls[1]?.[0]).toBe(fileB.path);
		expect(reconcilePathMock.mock.calls[1]?.[1]).toBe("note B text");
		expect(editor.getValue()).toBe("note B text");
		await controller.dispose();
	});

	test("active editor reconcile mirrors text into vaultFiles snapshot", async () => {
		const editor = createEditor("local");
		const file = new TFileCtor("note.md");
		const app = createApp(new MarkdownViewCtor(file, editor), [[file.path, file]]);
		openDocMock.mockResolvedValue(createSession());
		reconcilePathMock.mockResolvedValue({
			docId: "doc-1",
			path: file.path,
			text: "snapshot text",
			changed: true,
			usedFallbackBackup: false,
		});
		uploadLocalFileMock.mockResolvedValue("ok");

		const controller = startObsidianLiveSync({
			app: app as never,
			settings: { convexSecret: "secret" } as never,
			getRealtimeClient: () => ({}) as never,
			getFileSyncClient: () => ({}) as never,
			getPresenceSessionId: () => "client-1",
			setStatus: () => undefined,
		});

		await vi.waitFor(() => expect(uploadLocalFileMock).toHaveBeenCalledTimes(1));
		const call = uploadLocalFileMock.mock.calls[0];
		expect(call).toBeDefined();
		const [, secret, clientId, path, bytes, , options] = call!;
		expect(secret).toBe("secret");
		expect(clientId).toBe("client-1");
		expect(path).toBe("note.md");
		expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe("snapshot text");
		expect(options).toEqual({ force: true });
		await controller.dispose();
	});

	test("folder create publishes folder snapshot", async () => {
		vi.useFakeTimers();
		try {
			const editor = createEditor("local");
			const file = new TFileCtor("note.md");
			const folder = new TFolderCtor("new-folder");
			const app = createApp(new MarkdownViewCtor(file, editor), [
				[file.path, file],
				[folder.path, folder],
			]);
			const mutation = vi.fn(async (_fn: unknown, _args: unknown) => undefined);
			const fileSyncClient = { mutation };
			openDocMock.mockResolvedValue(createSession());
			reconcilePathMock.mockResolvedValue({
				docId: "doc-1",
				path: file.path,
				text: "local",
				changed: false,
				usedFallbackBackup: false,
			});

			const controller = startObsidianLiveSync({
				app: app as never,
				settings: { convexSecret: "secret" } as never,
				getRealtimeClient: () => ({}) as never,
				getFileSyncClient: () => fileSyncClient as never,
				getPresenceSessionId: () => "client-1",
				setStatus: () => undefined,
			});

			app.vault.emit("create", folder);
			await vi.advanceTimersByTimeAsync(300);

			expect(mutation).toHaveBeenCalledTimes(1);
			const args = mutation.mock.calls[0]?.[1] as {
				folderPaths: string[];
				emptyFolderPaths: string[];
			};
			expect(args.folderPaths).toContain("new-folder");
			expect(args.emptyFolderPaths).toContain("new-folder");
			await controller.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	test("remote folder snapshots create and delete empty folders", async () => {
		const editor = createEditor("local");
		const file = new TFileCtor("note.md");
		const app = createApp(new MarkdownViewCtor(file, editor), [[file.path, file]]);
		let onFolderSnapshot: ((rows: unknown[]) => void) | null = null;
		const realtimeClient = {
			onUpdate: vi.fn((_query, _args, callback: (rows: unknown[]) => void) => {
				onFolderSnapshot = callback;
				return () => undefined;
			}),
		};
		openDocMock.mockResolvedValue(createSession());
		reconcilePathMock.mockResolvedValue({
			docId: "doc-1",
			path: file.path,
			text: "local",
			changed: false,
			usedFallbackBackup: false,
		});

		const controller = startObsidianLiveSync({
			app: app as never,
			settings: { convexSecret: "secret" } as never,
			getRealtimeClient: () => realtimeClient as never,
			setStatus: () => undefined,
		});

		expect(onFolderSnapshot).not.toBeNull();
		const emitFolderSnapshot = onFolderSnapshot as unknown as (
			rows: unknown[],
		) => void;
		emitFolderSnapshot([
			{
				path: "remote-empty",
				updatedAtMs: 1,
				isExplicitlyEmpty: true,
				updatedByClientId: "peer",
			},
		]);
		await vi.waitFor(() =>
			expect(app.vault.getAbstractFileByPath("remote-empty")).toBeInstanceOf(
				TFolder,
			),
		);

		emitFolderSnapshot([]);
		await vi.waitFor(() =>
			expect(app.vault.getAbstractFileByPath("remote-empty")).toBeNull(),
		);
		await controller.dispose();
	});
});

function createEditor(initialValue: string) {
	let value = initialValue;
	return {
		getValue: () => value,
		setValue: (nextValue: string) => {
			value = nextValue;
		},
	};
}

function createSession(docId = "doc-1", path = "note.md") {
	return {
		docId,
		path,
		getTextSnapshot: () => "",
		applyLocalChange: vi.fn(async () => undefined),
		close: vi.fn(),
	};
}

function createApp(
	view: InstanceType<typeof MarkdownView>,
	files: Array<[string, TFile | TFolder]>,
	fileContents = new Map<string, string>(),
) {
	const fileMap = new Map(files);
	const workspace = createEventTarget();
	const vault = createEventTarget();
	return {
		workspace: {
			...workspace,
			getActiveViewOfType: (type: typeof MarkdownView) =>
				view instanceof type ? view : null,
		},
		vault: {
			...vault,
			getAllLoadedFiles: () => [...fileMap.values()],
			cachedRead: vi.fn(async (file: TFile) =>
				fileContents.get(file.path) ?? view.editor.getValue(),
			),
			read: vi.fn(async (file: TFile) =>
				fileContents.get(file.path) ?? view.editor.getValue(),
			),
			modify: vi.fn(async (file: TFile, text: string) => {
				fileContents.set(file.path, text);
			}),
			create: vi.fn(async (path: string, text: string) => {
				fileMap.set(path, new TFileCtor(path));
				fileContents.set(path, text);
			}),
			createFolder: vi.fn(async (path: string) => {
				const folder = new TFolderCtor(path);
				fileMap.set(path, folder);
				const parentPath = path.includes("/")
					? path.slice(0, path.lastIndexOf("/"))
					: "";
				const parent = fileMap.get(parentPath);
				if (parent instanceof TFolder && !parent.children.includes(folder)) {
					parent.children.push(folder);
				}
			}),
			delete: vi.fn(async (file: TFile | TFolder) => {
				fileMap.delete(file.path);
			}),
			rename: vi.fn(async (file: TFile, newPath: string) => {
				fileMap.delete(file.path);
				file.path = newPath;
				fileMap.set(newPath, file);
			}),
			getAbstractFileByPath: (path: string) => fileMap.get(path) ?? null,
			getName: () => "vault",
			adapter: {
				exists: vi.fn(async () => false),
				list: vi.fn(async () => ({ files: [], folders: [] })),
				stat: vi.fn(async () => null),
				readBinary: vi.fn(async () => new ArrayBuffer(0)),
				writeBinary: vi.fn(async () => undefined),
			},
		},
	};
}

function createEventTarget() {
	type Handler = { ref: object; callback: (...args: unknown[]) => void };
	const listeners = new Map<string, Handler[]>();
	return {
		on: (event: string, callback: (...args: unknown[]) => void) => {
			const ref = {};
			const handlers = listeners.get(event) ?? [];
			handlers.push({ ref, callback });
			listeners.set(event, handlers);
			return ref;
		},
		offref: (ref: object) => {
			for (const [event, handlers] of listeners.entries()) {
				listeners.set(
					event,
					handlers.filter((handler) => handler.ref !== ref),
				);
			}
		},
		emit: (event: string, ...args: unknown[]) => {
			for (const handler of listeners.get(event) ?? []) {
				handler.callback(...args);
			}
		},
		listenerCount: (event: string) => (listeners.get(event) ?? []).length,
	};
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
