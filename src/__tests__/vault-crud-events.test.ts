import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => {
	class TFile {
		path: string;
		extension: string;
		constructor(path: string) {
			this.path = path;
			const dot = path.lastIndexOf(".");
			this.extension = dot >= 0 ? path.slice(dot + 1) : "";
		}
	}
	class TFolder {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	}
	return {
		TFile,
		TFolder,
		normalizePath: (value: string) => value.replace(/\\/g, "/"),
	};
});

import { TFile } from "obsidian";
import { registerVaultCrudEventHandlers } from "../sync/vault-crud-events";

const TestTFile = TFile as unknown as new (path: string) => TFile;

describe("vault CRUD event registration", () => {
	it("registers handlers even when managers are null", () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		const registerEvent = vi.fn();
		const vault = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				handlers.set(event, handler);
				return `${event}-ref`;
			}),
		};

		registerVaultCrudEventHandlers({
			registerEvent,
			vault: vault as never,
			getDocManager: () => null,
			getBinarySync: () => null,
		});

		expect(registerEvent).toHaveBeenCalledTimes(4);
		expect(() => handlers.get("create")?.(new TestTFile("note.md"))).not.toThrow();
	});

	it("dispatches to binary sync when available after registration", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void>();
		let binarySync: { onLocalFileCreated: (file: unknown) => Promise<void> } | null = null;
		const onLocalFileCreated = vi.fn().mockResolvedValue(undefined);

		registerVaultCrudEventHandlers({
			registerEvent: vi.fn(),
			vault: {
				on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
					handlers.set(event, handler);
					return `${event}-ref`;
				}),
			} as never,
			getDocManager: () => null,
			getBinarySync: () => binarySync as never,
		});

		binarySync = { onLocalFileCreated };
		handlers.get("create")?.(new TestTFile("image.png"));
		await vi.waitFor(() => {
			expect(onLocalFileCreated).toHaveBeenCalledTimes(1);
		});
	});
});
