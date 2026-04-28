import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const refs = vi.hoisted(() => ({
	internal: {
		yjsSync: {
			_pruneOldSnapshotsOnce: "internal.yjsSync._pruneOldSnapshotsOnce",
			_insertSnapshotChunk: "internal.yjsSync._insertSnapshotChunk",
			_pruneOldUpdatesOnce: "internal.yjsSync._pruneOldUpdatesOnce",
			_markDocClean: "internal.yjsSync._markDocClean",
			_markCompactionComplete: "internal.yjsSync._markCompactionComplete",
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

import { _insertSnapshotChunk, _pruneOldSnapshotsOnce, _snapshotUpdates } from "../yjsSync";

type Handler<Args, Result> = (ctx: unknown, args: Args) => Promise<Result>;

function invokeHandler<Args, Result>(
	registeredFn: unknown,
	ctx: unknown,
	args: Args,
): Promise<Result> {
	return (registeredFn as { handler: Handler<Args, Result> }).handler(ctx, args);
}

describe("convex/yjsSync snapshot lifecycle", () => {
	it("prunes old snapshot rows one bounded batch at a time", async () => {
		const deletedIds: string[] = [];
		const data = new Uint8Array([1, 2]).buffer;
		const take = vi.fn().mockResolvedValue([
			{ _id: "s1", data },
			{ _id: "s2", data },
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

		const result = await invokeHandler(_pruneOldSnapshotsOnce, ctx, {
			docId: "vault::notes/test.md",
		});

		expect(result).toEqual({ more: false, rows: 2, bytesWritten: 4 });
		expect(take).toHaveBeenCalledWith(4);
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
		const doc = new Y.Doc();
		doc.getText("content").insert(0, "hello");
		const update = Y.encodeStateAsUpdate(doc);
		doc.destroy();
		let queryCount = 0;
		const ctx = {
			runQuery: vi.fn(async () => {
				queryCount += 1;
				return {
					page: queryCount === 1 ? [] : [{ _creationTime: 123, update: update.buffer }],
					isDone: true,
					continueCursor: "end",
				};
			}),
			runMutation: vi.fn(async (ref: string) => {
				calls.push(ref);
				if (
					ref === refs.internal.yjsSync._pruneOldSnapshotsOnce ||
					ref === refs.internal.yjsSync._pruneOldUpdatesOnce
				) {
					return { more: false, rows: 0, bytesWritten: 0 };
				}
				if (ref === refs.internal.yjsSync._markCompactionComplete) {
					return { shouldReschedule: false };
				}
				return null;
			}),
		};

		await invokeHandler(_snapshotUpdates, ctx, {
			docId: "vault::notes/test.md",
		});

		expect(calls).toEqual([
			refs.internal.yjsSync._pruneOldSnapshotsOnce,
			refs.internal.yjsSync._insertSnapshotChunk,
			refs.internal.yjsSync._pruneOldUpdatesOnce,
			refs.internal.yjsSync._markCompactionComplete,
		]);
	});
});
