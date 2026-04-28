import { beforeEach, describe, expect, it, vi } from "vitest";

const { hasCachedStateMock, saveMock, loadMock, readRemoteTextContentMock } = vi.hoisted(() => ({
	hasCachedStateMock: vi.fn(),
	saveMock: vi.fn(),
	loadMock: vi.fn(),
	readRemoteTextContentMock: vi.fn(),
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

vi.mock("../sync/text-sync-transport", () => ({
	readRemoteTextContent: readRemoteTextContentMock,
	pushTextContentSnapshot: vi.fn(),
}));

import { DocManager } from "../sync/doc-manager";

describe("DocManager warm-up cache fill", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		hasCachedStateMock.mockResolvedValue(false);
		loadMock.mockResolvedValue(undefined);
		saveMock.mockResolvedValue(undefined);
		readRemoteTextContentMock.mockResolvedValue("Hello World");
	});

	it("stores remote text docs in the local cache after warm-up", async () => {
		const manager = new DocManager(
			{
				vault: { getName: () => "vaultA" },
				workspace: { updateOptions: vi.fn() },
			} as never,
			{} as never,
			{} as never,
			"clientA",
			"secretA",
		);

		await manager.warmUpAllDocs(["a.md", "b.md", "c.md"]);

		expect(readRemoteTextContentMock).toHaveBeenCalledTimes(3);
		expect(saveMock).toHaveBeenCalledTimes(3);
	});
});
