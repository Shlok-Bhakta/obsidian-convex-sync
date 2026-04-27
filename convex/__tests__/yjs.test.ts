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
									{ _id: "s1", data: new Uint8Array([1, 2]).buffer },
									{ _id: "s2", data: new Uint8Array([3]).buffer },
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
		};

		await invokeHandler(_createSnapshot, ctx, {
			docId: "vault::notes/test.md",
			timestamp: 123,
			data: new Uint8Array([9, 9]).buffer,
		});

		expect(inserts.length).toBe(0);
		expect(patches.length).toBeGreaterThan(0);
		expect(new Uint8Array(patches[0].data as ArrayBuffer)).toEqual(new Uint8Array([9, 9]));
		expect(deletedIds).toContain("s2");
	});
});
