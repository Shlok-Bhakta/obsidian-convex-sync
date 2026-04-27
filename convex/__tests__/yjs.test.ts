import { describe, expect, it, vi } from "vitest";

const refs = vi.hoisted(() => ({
	internal: {
		yjs: {
			_pruneOldSnapshotsOnce: "internal.yjs._pruneOldSnapshotsOnce",
			_insertSnapshotChunk: "internal.yjs._insertSnapshotChunk",
			_pruneOldUpdatesOnce: "internal.yjs._pruneOldUpdatesOnce",
			_markDocClean: "internal.yjs._markDocClean",
		},
	},
}));

vi.mock("../_generated/server", () => ({
	mutation: (config: unknown) => config,
	query: (config: unknown) => config,
	internalMutation: (config: unknown) => config,
	internalQuery: (config: unknown) => config,
	internalAction: (config: unknown) => config,
	action: (config: unknown) => config,
	paginationOptsValidator: {},
}));

vi.mock("../_generated/api", () => refs);

import { _insertSnapshotChunk, _pruneOldSnapshotsOnce, _snapshotUpdates } from "../yjs";

type Handler<Args, Result> = (ctx: unknown, args: Args) => Promise<Result>;

function invokeHandler<Args, Result>(
	registeredFn: unknown,
	ctx: unknown,
	args: Args,
): Promise<Result> {
	return (registeredFn as { handler: Handler<Args, Result> }).handler(ctx, args);
}

describe("convex/yjs snapshot lifecycle", () => {
	it("prunes old snapshot rows one bounded batch at a time", async () => {
		const deletedIds: string[] = [];
		const take = vi.fn().mockResolvedValue([
			{ _id: "s1" },
			{ _id: "s2" },
		]);
		const ctx = {
			db: {
				query: vi.fn(() => ({
					withIndex: vi.fn(() => ({ take })),
				})),
				delete: vi.fn(async (id: string) => {
					deletedIds.push(id);
				}),
			},
		};

		const more = await invokeHandler(_pruneOldSnapshotsOnce, ctx, {
			docId: "vault::notes/test.md",
		});

		expect(more).toBe(false);
		expect(take).toHaveBeenCalledWith(16);
		expect(deletedIds).toEqual(["s1", "s2"]);
	});

	it("inserts a single snapshot chunk without pruning old rows", async () => {
		const inserts: Array<Record<string, unknown>> = [];
		const ctx = {
			db: {
				insert: vi.fn(async (_table: string, row: Record<string, unknown>) => {
					inserts.push(row);
					return "new-snapshot";
				}),
			},
		};

		await invokeHandler(_insertSnapshotChunk, ctx, {
			docId: "vault::notes/test.md",
			data: new Uint8Array([9, 9]).buffer,
		});

		expect(inserts).toHaveLength(1);
		expect(new Uint8Array(inserts[0].data as ArrayBuffer)).toEqual(new Uint8Array([9, 9]));
	});

	it("orchestrates snapshot cleanup and chunk insertion from the action", async () => {
		const calls: string[] = [];
		const update = new Uint8Array([1, 2, 3]);
		const ctx = {
			runQuery: vi.fn(async () => ({
				page: [{ _creationTime: 123, update: update.buffer }],
				isDone: true,
				continueCursor: "end",
			})),
			runMutation: vi.fn(async (ref: string) => {
				calls.push(ref);
				return false;
			}),
		};

		await invokeHandler(_snapshotUpdates, ctx, {
			docId: "vault::notes/test.md",
		});

		expect(calls).toEqual([
			refs.internal.yjs._pruneOldSnapshotsOnce,
			refs.internal.yjs._insertSnapshotChunk,
			refs.internal.yjs._pruneOldUpdatesOnce,
			refs.internal.yjs._markDocClean,
		]);
	});
});
