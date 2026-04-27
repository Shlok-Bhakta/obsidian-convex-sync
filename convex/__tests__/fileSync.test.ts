import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../_generated/server", () => ({
	mutation: (config: unknown) => config,
	query: (config: unknown) => config,
	internalMutation: (config: unknown) => config,
	internalQuery: (config: unknown) => config,
	internalAction: (config: unknown) => config,
	action: (config: unknown) => config,
	paginationOptsValidator: {},
}));

vi.mock("../security", () => ({
	requirePluginSecret: vi.fn().mockResolvedValue(undefined),
}));

import {
	listBinarySnapshotPage,
	registerTextFile,
	removeFilesByPath,
	syncFolderState,
} from "../fileSync";

type Handler<Args, Result> = (ctx: unknown, args: Args) => Promise<Result>;

function invokeHandler<Args, Result>(
	registeredFn: unknown,
	ctx: unknown,
	args: Args,
): Promise<Result> {
	return (registeredFn as { handler: Handler<Args, Result> }).handler(ctx, args);
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const storageDelete = vi.fn().mockResolvedValue(undefined);
	const dbPatch = vi.fn().mockResolvedValue(undefined);
	const dbInsert = vi.fn().mockResolvedValue("new-id");
	const dbDelete = vi.fn().mockResolvedValue(undefined);
	const runAfter = vi.fn().mockResolvedValue(undefined);
	const queryByPathUnique = vi.fn();

	return {
		ctx: {
			db: {
				query: vi.fn((table: string) => {
					if (table === "vaultFiles") {
						return {
							withIndex: () => ({ unique: queryByPathUnique }),
							collect: vi.fn().mockResolvedValue([]),
						};
					}
					if (table === "vaultFolders") {
						return { collect: vi.fn().mockResolvedValue([]) };
					}
					if (table === "yjsSnapshots" || table === "yjsUpdates") {
						return { collect: vi.fn().mockResolvedValue([]) };
					}
					return { collect: vi.fn().mockResolvedValue([]) };
				}),
				patch: dbPatch,
				insert: dbInsert,
				delete: dbDelete,
			},
			storage: { delete: storageDelete },
			scheduler: { runAfter },
			...overrides,
		},
		mocks: { storageDelete, dbPatch, dbInsert, dbDelete, runAfter, queryByPathUnique },
	};
}

describe("convex/fileSync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registerTextFile updates existing row and clears storageId", async () => {
		const { ctx, mocks } = makeCtx();
		mocks.queryByPathUnique.mockResolvedValue({
			_id: "file-1",
			storageId: "storage-1",
			isText: true,
		});

		await invokeHandler(registerTextFile, ctx, {
			convexSecret: "secret",
			path: "notes/hello.md",
			contentHash: "new-hash",
			sizeBytes: 200,
			updatedAtMs: 1000,
			clientId: "client-1",
		});

		expect(mocks.storageDelete).toHaveBeenCalledWith("storage-1");
		expect(mocks.dbPatch).toHaveBeenCalledWith(
			"file-1",
			expect.objectContaining({
				contentHash: "new-hash",
				sizeBytes: 200,
				storageId: undefined,
				isText: true,
			}),
		);
	});

	it("removeFilesByPath deletes blob and row", async () => {
		const { ctx, mocks } = makeCtx();
		mocks.queryByPathUnique.mockResolvedValue({
			_id: "file-1",
			storageId: "storage-1",
			isText: false,
		});

		await invokeHandler(removeFilesByPath, ctx, {
			convexSecret: "secret",
			removedPaths: ["assets/pic.png"],
		});

		expect(mocks.storageDelete).toHaveBeenCalledWith("storage-1");
		expect(mocks.dbDelete).toHaveBeenCalledWith("file-1");
	});

	it("removeFilesByPath schedules Yjs cleanup for text docs", async () => {
		const { ctx, mocks } = makeCtx();
		mocks.queryByPathUnique.mockResolvedValue({
			_id: "file-2",
			storageId: undefined,
			isText: true,
		});

		await invokeHandler(removeFilesByPath, ctx, {
			convexSecret: "secret",
			removedPaths: ["notes/removed.md"],
		});

		expect(mocks.runAfter).toHaveBeenCalledWith(
			0,
			expect.anything(),
			expect.objectContaining({ path: "notes/removed.md" }),
		);
	});

	it("syncFolderState keeps non-empty rows non-empty", async () => {
		const dbPatch = vi.fn().mockResolvedValue(undefined);
		const dbInsert = vi.fn().mockResolvedValue(undefined);
		const dbDelete = vi.fn().mockResolvedValue(undefined);
		const { ctx } = makeCtx({
			db: {
				query: vi.fn((table: string) => {
					if (table === "vaultFolders") {
						return {
							collect: vi.fn().mockResolvedValue([
								{ _id: "folder-1", path: "projects", isExplicitlyEmpty: false },
							]),
						};
					}
					return { collect: vi.fn().mockResolvedValue([]) };
				}),
				patch: dbPatch,
				insert: dbInsert,
				delete: dbDelete,
			},
		});

		await invokeHandler(syncFolderState, ctx, {
			convexSecret: "secret",
			scannedAtMs: 123,
			clientId: "client",
			emptyFolderPaths: [],
		});

		expect(dbPatch).not.toHaveBeenCalledWith(
			"folder-1",
			expect.objectContaining({ isExplicitlyEmpty: true }),
		);
	});

	it("listBinarySnapshotPage returns paginated binary rows", async () => {
		const { ctx } = makeCtx({
			db: {
				query: vi.fn((table: string) => {
					if (table === "vaultFiles") {
						return {
							withIndex: () => ({
								paginate: vi.fn().mockResolvedValue({
									page: [
										{
											path: "assets/image.png",
											contentHash: "abc123",
											sizeBytes: 100,
											updatedAtMs: 12,
											updatedByClientId: "client-1",
											isText: false,
											storageId: "storage-1",
										},
									],
									isDone: true,
									continueCursor: "end",
								}),
							}),
						};
					}
					return { collect: vi.fn().mockResolvedValue([]) };
				}),
			},
		});

		const result = await invokeHandler<
			{ convexSecret: string; paginationOpts: { cursor: string | null; numItems: number } },
			{ page: unknown[]; isDone: boolean; continueCursor: string }
		>(
			listBinarySnapshotPage,
			ctx,
			{
				convexSecret: "secret",
				paginationOpts: { cursor: null, numItems: 200 },
			},
		);
		expect(result.page).toContainEqual(
			expect.objectContaining({
				path: "assets/image.png",
				isText: false,
				sizeBytes: 100,
				contentHash: "abc123",
			}),
		);
	});
});
