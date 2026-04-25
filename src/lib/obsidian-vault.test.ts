import { describe, expect, test, vi } from "vitest";

vi.mock("obsidian", () => {
	class TAbstractFile {
		constructor(public path: string) {}
	}

	class TFile extends TAbstractFile {}
	class TFolder extends TAbstractFile {}

	return {
		TFile,
		TFolder,
		normalizePath: (path: string) => path,
	};
});

import { TFile, TFolder } from "obsidian";
import {
	ensureAdapterFolderExists,
	ensureVaultFolderExists,
} from "./obsidian-vault";

const TFolderCtor = TFolder as unknown as { new (path: string): TFolder };
const TFileCtor = TFile as unknown as { new (path: string): TFile };

describe("obsidian vault folder helpers", () => {
	test("ensureVaultFolderExists tolerates concurrent folder creation", async () => {
		const folders = new Set<string>(["notes"]);
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) =>
					folders.has(path) ? new TFolderCtor(path) : null,
				createFolder: vi.fn(async (path: string) => {
					folders.add(path);
					throw new Error("Folder already exists.");
				}),
			},
		};

		await expect(
			ensureVaultFolderExists(app as never, "notes/projects"),
		).resolves.toBeUndefined();
		expect(app.vault.createFolder).toHaveBeenCalledWith("notes/projects");
	});

	test("ensureVaultFolderExists rethrows when the path resolves to a file", async () => {
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) =>
					path === "notes/projects" ? new TFileCtor(path) : new TFolderCtor("notes"),
				adapter: {
					stat: vi.fn(async (path: string) =>
						path === "notes/projects" ? { type: "file" as const } : null,
					),
				},
				createFolder: vi.fn(async () => {
					throw new Error("Folder already exists.");
				}),
			},
		};

		await expect(
			ensureVaultFolderExists(app as never, "notes/projects"),
		).rejects.toThrow("Folder already exists.");
	});

	test("ensureVaultFolderExists tolerates adapter-visible folders before vault cache updates", async () => {
		const folders = new Set<string>(["notes"]);
		const app = {
			vault: {
				getAbstractFileByPath: (path: string) =>
					path === "notes" ? new TFolderCtor(path) : null,
				adapter: {
					stat: vi.fn(async (path: string) =>
						folders.has(path) ? { type: "folder" as const } : null,
					),
				},
				createFolder: vi.fn(async (path: string) => {
					folders.add(path);
					throw new Error("Folder already exists.");
				}),
			},
		};

		await expect(
			ensureVaultFolderExists(app as never, "notes/projects"),
		).resolves.toBeUndefined();
	});

	test("ensureAdapterFolderExists tolerates concurrent folder creation", async () => {
		const folders = new Set<string>([".obsidian"]);
		const app = {
			vault: {
				adapter: {
					exists: vi.fn(async (path: string) => folders.has(path)),
					mkdir: vi.fn(async (path: string) => {
						folders.add(path);
						throw new Error("Folder already exists.");
					}),
					stat: vi.fn(async (path: string) =>
						folders.has(path) ? { type: "folder" as const } : null,
					),
				},
			},
		};

		await expect(
			ensureAdapterFolderExists(app as never, ".obsidian/plugins"),
		).resolves.toBeUndefined();
		expect(app.vault.adapter.mkdir).toHaveBeenCalledWith(".obsidian/plugins");
	});
});
