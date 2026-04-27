import { describe, expect, it, vi } from "vitest";

vi.mock("../_generated/server", () => ({
	mutation: (config: unknown) => config,
	query: (config: unknown) => config,
	internalMutation: (config: unknown) => config,
	internalQuery: (config: unknown) => config,
	internalAction: (config: unknown) => config,
	action: (config: unknown) => config,
}));

import { _createSnapshot } from "../yjs";

type Handler<Args, Result> = (ctx: unknown, args: Args) => Promise<Result>;

function invokeHandler<Args, Result>(
	registeredFn: unknown,
	ctx: unknown,
	args: Args,
): Promise<Result> {
	return (registeredFn as { handler: Handler<Args, Result> }).handler(ctx, args);
}

describe("convex/yjs snapshot lifecycle", () => {
	it("keeps a single snapshot row when duplicates exist", async () => {
		const inserts: Array<Record<string, unknown>> = [];
		const patches: Array<Record<string, unknown>> = [];
		const deletedIds: string[] = [];
		const deletedStorage: string[] = [];

		const ctx = {
			db: {
				query: vi.fn((table: string) => {
					if (table === "yjsUpdates") {
						return {
							withIndex: () => ({
								collect: vi.fn().mockResolvedValue([
									{ _id: "u1" },
									{ _id: "u2" },
								]),
							}),
						};
					}
					if (table === "yjsSnapshots") {
						return {
							withIndex: () => ({
								collect: vi.fn().mockResolvedValue([
									{ _id: "s1", fileId: "old1" },
									{ _id: "s2", fileId: "old2" },
								]),
							}),
						};
					}
					return { withIndex: () => ({ collect: vi.fn().mockResolvedValue([]) }) };
				}),
				insert: vi.fn(async (_table: string, row: Record<string, unknown>) => {
					inserts.push(row);
					return "new-snapshot";
				}),
				patch: vi.fn(async (_id: string, row: Record<string, unknown>) => {
					patches.push(row);
				}),
				delete: vi.fn(async (id: string) => {
					deletedIds.push(id);
				}),
			},
			storage: {
				delete: vi.fn(async (fileId: string) => {
					deletedStorage.push(fileId);
				}),
			},
		};

		await invokeHandler(_createSnapshot, ctx, {
			docId: "vault::notes/test.md",
			timestamp: 123,
			fileId: "new-file",
		});

		expect(inserts.length).toBe(0);
		expect(patches).toContainEqual({ fileId: "new-file" });
		expect(deletedIds).toContain("s2");
		expect(deletedStorage).toContain("old1");
		expect(deletedStorage).toContain("old2");
	});
});
