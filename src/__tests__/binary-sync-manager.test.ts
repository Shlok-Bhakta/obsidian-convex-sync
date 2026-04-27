import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mutationMock, readBinaryMock, uploadLocalFileMock, readRemoteFileBytesMock, noticeMock } = vi.hoisted(() => ({
	mutationMock: vi.fn(),
	readBinaryMock: vi.fn(),
	uploadLocalFileMock: vi.fn(),
	readRemoteFileBytesMock: vi.fn(),
	noticeMock: vi.fn(),
}));

vi.mock("idb-keyval", () => {
	const store = new Map<string, unknown>();
	return {
		createStore: vi.fn(() => ({})),
		get: vi.fn(async (key: string) => store.get(String(key))),
		set: vi.fn(async (key: string, value: unknown) => {
			store.set(String(key), value);
		}),
		del: vi.fn(async (key: string) => {
			store.delete(String(key));
		}),
		keys: vi.fn(async () => Array.from(store.keys())),
	};
});

vi.mock("obsidian", () => {
	class TFile {
		path: string;
		stat: { mtime: number };
		constructor(path: string, mtime = Date.now()) {
			this.path = path;
			this.stat = { mtime };
		}
	}
	class TFolder {}
	class Notice {
		constructor(message: string, timeout?: number) {
			noticeMock(message, timeout);
		}
	}
	return {
		TFile,
		TFolder,
		Notice,
		normalizePath: (value: string) => value.replace(/\\/g, "/"),
	};
});

vi.mock("../file-sync", async () => {
	const actual = await vi.importActual<typeof import("../file-sync")>("../file-sync");
	return {
		...actual,
		uploadLocalFile: uploadLocalFileMock,
		readRemoteFileBytes: readRemoteFileBytesMock,
	};
});

import { TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings/index";
import { BinarySyncManager } from "../sync/binary-sync-manager";
import { del, keys, set } from "idb-keyval";

describe("BinarySyncManager", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		readRemoteFileBytesMock.mockResolvedValue({ bytes: new ArrayBuffer(4), updatedAtMs: Date.now() });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("registers new folder path on rename", async () => {
		const manager = new BinarySyncManager(
			{
				vault: {
					readBinary: readBinaryMock,
					getAbstractFileByPath: vi.fn(),
					adapter: { exists: vi.fn(), remove: vi.fn() },
					createFolder: vi.fn(),
					delete: vi.fn(),
				},
			} as never,
			{ mutation: mutationMock } as never,
			{} as never,
			"secret",
			"client",
			async () => {},
			{ ...DEFAULT_SETTINGS },
		);

		await manager.onLocalFolderRenamed("old/folder", "new/folder");

		expect(mutationMock).toHaveBeenNthCalledWith(
			1,
			expect.anything(),
			expect.objectContaining({ removedPaths: ["old/folder"] }),
		);
		expect(mutationMock).toHaveBeenNthCalledWith(
			2,
			expect.anything(),
			expect.objectContaining({ path: "new/folder" }),
		);
	});

	it("serializes create+modify uploads for same path", async () => {
		let releaseUpload: () => void = () => {};
		uploadLocalFileMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					releaseUpload = () => resolve("ok");
				}),
		);

		const TestTFile = TFile as unknown as new (path: string, mtime?: number) => TFile;
		const liveFile = new TestTFile("assets/image.png", 1000);
		const getAbstractFileByPath = vi.fn().mockReturnValue(liveFile);
		readBinaryMock.mockResolvedValue(new ArrayBuffer(8));

		const manager = new BinarySyncManager(
			{
				vault: {
					readBinary: readBinaryMock,
					getAbstractFileByPath,
					adapter: { exists: vi.fn(), remove: vi.fn() },
					createFolder: vi.fn(),
					delete: vi.fn(),
				},
			} as never,
			{ mutation: mutationMock } as never,
			{} as never,
			"secret",
			"client",
			async () => {},
			{ ...DEFAULT_SETTINGS },
		);

		const createPromise = manager.onLocalFileCreated(liveFile);
		await manager.onLocalFileModified(liveFile);
		await vi.advanceTimersByTimeAsync(900);
		expect(uploadLocalFileMock).toHaveBeenCalledTimes(1);

		releaseUpload();
		await createPromise;
		await vi.waitFor(() => {
			expect(uploadLocalFileMock).toHaveBeenCalledTimes(2);
		});
	});

	it("notifies only when sync actually changes .obsidian paths", async () => {
		for (const key of await keys()) {
			await del(key);
		}
		const queryMock = vi.fn().mockResolvedValue({
			files: [
				{
					path: ".obsidian/workspace.json",
					contentHash: "hash-a",
					updatedAtMs: 1,
					updatedByClientId: "remote",
					isText: false,
				},
			],
			folders: [],
		});
		const manager = new BinarySyncManager(
			{
				vault: {
					readBinary: readBinaryMock,
					getAbstractFileByPath: vi.fn(),
					adapter: {
						exists: vi.fn().mockResolvedValue(true),
						remove: vi.fn().mockResolvedValue(undefined),
						stat: vi.fn().mockResolvedValue({ type: "file" }),
						writeBinary: vi.fn(),
					},
					createFolder: vi.fn(),
					createBinary: vi.fn(),
					modifyBinary: vi.fn(),
					delete: vi.fn(),
				},
			} as never,
			{ query: queryMock, mutation: mutationMock } as never,
			{ onUpdate: vi.fn() } as never,
			"secret",
			"client",
			async () => {},
			{ ...DEFAULT_SETTINGS },
		);

		await set("binarySync:hash:.obsidian/workspace.json", "hash-a");

		// First push: unchanged hash, no local sync write, no notice.
		await (manager as unknown as {
			onRemoteMetadata: (remote: {
				files: Array<{
					path: string;
					contentHash: string;
					updatedAtMs: number;
					updatedByClientId: string;
					isText: boolean;
				}>;
				folders: Array<{
					path: string;
					updatedAtMs: number;
					updatedByClientId: string;
					isExplicitlyEmpty: boolean;
				}>;
			}) => Promise<void>;
		}).onRemoteMetadata({
			files: [
				{
					path: ".obsidian/workspace.json",
					contentHash: "hash-a",
					updatedAtMs: 20,
					updatedByClientId: "remote",
					isText: false,
				},
			],
			folders: [],
		});
		expect(noticeMock).not.toHaveBeenCalled();

		// Baseline snapshot: same remote hash again should remain quiet.
		await (manager as unknown as {
			onRemoteMetadata: (remote: {
				files: Array<{
					path: string;
					contentHash: string;
					updatedAtMs: number;
					updatedByClientId: string;
					isText: boolean;
				}>;
				folders: Array<{
					path: string;
					updatedAtMs: number;
					updatedByClientId: string;
					isExplicitlyEmpty: boolean;
				}>;
			}) => Promise<void>;
		}).onRemoteMetadata({
			files: [
				{
					path: ".obsidian/workspace.json",
					contentHash: "hash-a",
					updatedAtMs: 21,
					updatedByClientId: "remote",
					isText: false,
				},
			],
			folders: [],
		});
		expect(noticeMock).not.toHaveBeenCalled();

		// Second push: changed hash, sync applies remote bytes, notice shown once.
		await (manager as unknown as {
			onRemoteMetadata: (remote: {
				files: Array<{
					path: string;
					contentHash: string;
					updatedAtMs: number;
					updatedByClientId: string;
					isText: boolean;
				}>;
				folders: Array<{
					path: string;
					updatedAtMs: number;
					updatedByClientId: string;
					isExplicitlyEmpty: boolean;
				}>;
			}) => Promise<void>;
		}).onRemoteMetadata({
			files: [
				{
					path: ".obsidian/workspace.json",
					contentHash: "hash-b",
					updatedAtMs: 30,
					updatedByClientId: "remote",
					isText: false,
				},
			],
			folders: [],
		});
		expect(noticeMock).toHaveBeenCalledTimes(1);
	});

	it("does not repull text paths while local delete is pending remote ack", async () => {
		const pulled: string[] = [];
		const queryMock = vi.fn().mockResolvedValue({
			files: [
				{
					path: "gone.md",
					contentHash: "h1",
					updatedAtMs: 1,
					updatedByClientId: "remote",
					isText: true,
				},
			],
			folders: [],
		});
		const manager = new BinarySyncManager(
			{
				vault: {
					readBinary: readBinaryMock,
					getAbstractFileByPath: vi.fn().mockReturnValue(undefined),
					adapter: {
						exists: vi.fn(),
						remove: vi.fn().mockResolvedValue(undefined),
					},
					createFolder: vi.fn(),
					delete: vi.fn(),
				},
			} as never,
			{ query: queryMock, mutation: mutationMock } as never,
			{ onUpdate: vi.fn() } as never,
			"secret",
			"client",
			async (paths: string[]) => {
				pulled.push(...paths);
			},
			{ ...DEFAULT_SETTINGS },
		);

		const onRemoteMetadata = (manager as unknown as {
			onRemoteMetadata: (remote: {
				files: Array<{
					path: string;
					contentHash: string;
					updatedAtMs: number;
					updatedByClientId: string;
					isText: boolean;
				}>;
				folders: Array<{
					path: string;
					updatedAtMs: number;
					updatedByClientId: string;
					isExplicitlyEmpty: boolean;
				}>;
			}) => Promise<void>;
		}).onRemoteMetadata;

		await onRemoteMetadata.call(manager, {
			files: [
				{
					path: "gone.md",
					contentHash: "h1",
					updatedAtMs: 1,
					updatedByClientId: "remote",
					isText: true,
				},
			],
			folders: [],
		});
		expect(pulled).toEqual(["gone.md"]);

		manager.noteLocalDeletePending("gone.md");
		await onRemoteMetadata.call(manager, {
			files: [
				{
					path: "gone.md",
					contentHash: "h1",
					updatedAtMs: 1,
					updatedByClientId: "remote",
					isText: true,
				},
			],
			folders: [],
		});
		expect(pulled).toEqual(["gone.md"]);

		await onRemoteMetadata.call(manager, { files: [], folders: [] });
		expect(pulled).toEqual(["gone.md"]);

		await onRemoteMetadata.call(manager, {
			files: [{ path: "gone.md", contentHash: "h1", updatedAtMs: 1, isText: true }],
			folders: [],
		});
		expect(pulled).toEqual(["gone.md", "gone.md"]);
	});
});
