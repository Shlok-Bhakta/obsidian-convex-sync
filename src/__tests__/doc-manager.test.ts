import { beforeEach, describe, expect, it, vi } from "vitest";

const { mutationMock, hasCachedStateMock, saveMock, loadMock } = vi.hoisted(() => ({
	mutationMock: vi.fn(),
	hasCachedStateMock: vi.fn(),
	saveMock: vi.fn(),
	loadMock: vi.fn(),
}));

vi.mock("obsidian", () => ({
	normalizePath: (value: string) => value.replace(/\\/g, "/"),
}));

vi.mock("../sync/yjs-local-cache", () => ({
	YjsLocalCache: {
		hasCachedState: hasCachedStateMock,
		load: loadMock,
		save: saveMock,
	},
}));

vi.mock("../sync/ConvexYjsProvider", () => ({
	ConvexYjsProvider: class {
		constructor(
			private readonly _client: unknown,
			private readonly _docId: string,
			private readonly doc: { getText: (name: string) => { insert: (index: number, text: string) => void } },
		) {}
		async init() {
			this.doc.getText("content").insert(0, "Hello World");
		}
		startSync() {}
		destroy() {}
	},
}));

import { DocManager } from "../sync/doc-manager";

describe("DocManager warm-up manifest sync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		hasCachedStateMock.mockResolvedValue(false);
		loadMock.mockResolvedValue(undefined);
		saveMock.mockResolvedValue(undefined);
		mutationMock.mockResolvedValue(undefined);
	});

	it("registers text file metadata after warm-up", async () => {
		const manager = new DocManager(
			{
				vault: { getName: () => "vaultA" },
				workspace: { updateOptions: vi.fn() },
			} as never,
			{ mutation: mutationMock } as never,
			{ fileSync: { registerTextFile: "registerTextFile" } } as never,
			"clientA",
			"secretA",
		);

		await manager.warmUpAllDocs(["a.md", "b.md", "c.md"]);

		expect(mutationMock).toHaveBeenCalledTimes(3);
		expect(mutationMock).toHaveBeenNthCalledWith(
			1,
			"registerTextFile",
			expect.objectContaining({
				path: "a.md",
				sizeBytes: 11,
				clientId: "clientA",
			}),
		);
		expect(mutationMock).toHaveBeenNthCalledWith(
			3,
			"registerTextFile",
			expect.objectContaining({
				path: "c.md",
				sizeBytes: 11,
			}),
		);
	});
});
