import { describe, expect, test, vi } from "vitest";

vi.mock("obsidian", () => {
	class TAbstractFile {
		constructor(public path: string) {}
	}

	class TFile extends TAbstractFile {
		stat = { mtime: 1 };
	}

	class TFolder extends TAbstractFile {
		constructor(
			path: string,
			public children: TAbstractFile[] = [],
		) {
			super(path);
		}
	}

	return {
		TFile,
		TFolder,
		normalizePath: (path: string) => path,
	};
});

import { TFile, TFolder } from "obsidian";
import { listLocalEntries } from "./local-entries";

const TFileCtor = TFile as unknown as { new (path: string): TFile };
const TFolderCtor = TFolder as unknown as {
	new (path: string, children?: Array<TFile | TFolder>): TFolder;
};

describe("listLocalEntries", () => {
	test("returns all synced folders and separately marks empty folders", async () => {
		const note = new TFileCtor("notes/note.md");
		const ignoredBackup = new TFileCtor("notes/empty/old.convex-merge-backup-20260425-140000.md");
		const empty = new TFolderCtor("notes/empty", [ignoredBackup]);
		const notes = new TFolderCtor("notes", [note, empty]);
		const root = new TFolderCtor("", [notes]);
		const adapterFiles = new Map<string, ArrayBuffer>([
			[".obsidian/app.json", new ArrayBuffer(0)],
		]);
		const host = {
			app: {
				vault: {
					getAllLoadedFiles: () => [root, notes, note, empty, ignoredBackup],
					readBinary: vi.fn(async () => new ArrayBuffer(0)),
					modifyBinary: vi.fn(async () => undefined),
					createBinary: vi.fn(async () => undefined),
					adapter: {
						exists: vi.fn(async (path: string) => path === ".obsidian"),
						list: vi.fn(async (path: string) => {
							if (path === ".obsidian") {
								return {
									files: [".obsidian/app.json"],
									folders: [".obsidian/snippets"],
								};
							}
							if (path === ".obsidian/snippets") {
								return { files: [], folders: [] };
							}
							return { files: [], folders: [] };
						}),
						stat: vi.fn(async (path: string) =>
							adapterFiles.has(path) ? { type: "file", mtime: 2 } : null,
						),
						readBinary: vi.fn(async (path: string) => adapterFiles.get(path) ?? new ArrayBuffer(0)),
						writeBinary: vi.fn(async () => undefined),
					},
				},
			},
		};

		const state = await listLocalEntries(host as never);

		expect(state.files.map((file) => file.path).sort()).toEqual([
			".obsidian/app.json",
			"notes/note.md",
		]);
		expect(state.folders.sort()).toEqual([
			".obsidian",
			".obsidian/snippets",
			"notes",
			"notes/empty",
		]);
		expect(state.emptyFolders.sort()).toEqual([
			".obsidian/snippets",
			"notes/empty",
		]);
	});
});
