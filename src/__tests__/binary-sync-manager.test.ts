import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mutationMock, readBinaryMock, uploadLocalFileMock } = vi.hoisted(() => ({
	mutationMock: vi.fn(),
	readBinaryMock: vi.fn(),
	uploadLocalFileMock: vi.fn(),
}));

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
	return {
		TFile,
		TFolder,
		normalizePath: (value: string) => value.replace(/\\/g, "/"),
	};
});

vi.mock("../file-sync", async () => {
	const actual = await vi.importActual<typeof import("../file-sync")>("../file-sync");
	return {
		...actual,
		uploadLocalFile: uploadLocalFileMock,
	};
});

import { TFile } from "obsidian";
import { BinarySyncManager } from "../sync/binary-sync-manager";

describe("BinarySyncManager", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
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
});
