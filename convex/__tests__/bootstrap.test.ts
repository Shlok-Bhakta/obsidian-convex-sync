import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

const refs = vi.hoisted(() => ({
	internal: {
		yjsSync: {
			_listDocIdsWithPendingUpdates: "internal.yjsSync._listDocIdsWithPendingUpdates",
			_snapshotUpdates: "internal.yjsSync._snapshotUpdates",
		},
		bootstrap: {
			_readSnapshot: "internal.bootstrap._readSnapshot",
			issueZipUploadUrl: "internal.bootstrap.issueZipUploadUrl",
			updateProgress: "internal.bootstrap.updateProgress",
			finalizeArchive: "internal.bootstrap.finalizeArchive",
			failBuild: "internal.bootstrap.failBuild",
		},
	},
	api: {
		yjsSync: {
			init: "api.yjsSync.init",
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
}));

vi.mock("../_generated/api", () => refs);

vi.mock("../security", () => ({
	requirePluginSecret: vi.fn().mockResolvedValue(undefined),
}));

import { buildArchive } from "../bootstrapArchive";

function mockZipUpload() {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
			const body = init?.body;
			if (body instanceof Readable) {
				await pipeline(
					body,
					new Writable({
						write(_chunk, _enc, cb) {
							cb();
						},
					}),
				);
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ storageId: "zip-storage" }),
			};
		}),
	);
}

type Handler<Args, Result> = (ctx: unknown, args: Args) => Promise<Result>;

function invokeHandler<Args, Result>(
	registeredFn: unknown,
	ctx: unknown,
	args: Args,
): Promise<Result> {
	return (registeredFn as { handler: Handler<Args, Result> }).handler(ctx, args);
}

describe("convex/bootstrap", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("snapshots pending updates before reading file snapshot", async () => {
		mockZipUpload();
		const calls: string[] = [];
		const ctx = {
			runQuery: vi.fn(async (ref: string) => {
				calls.push(`query:${ref}`);
				if (ref === refs.internal.yjsSync._listDocIdsWithPendingUpdates) {
					return ["vault::notes/test.md"];
				}
				if (ref === refs.internal.bootstrap._readSnapshot) {
					return {
						files: [{ path: "notes/test.md", isText: true, sizeBytes: 0 }],
					};
				}
				return null;
			}),
			runAction: vi.fn(async (ref: string) => {
				calls.push(`action:${ref}`);
				if (ref === refs.api.yjsSync.init) {
					return { update: new ArrayBuffer(0), serverStateVector: new ArrayBuffer(0) };
				}
				return null;
			}),
			runMutation: vi.fn(async (ref: string) => {
				calls.push(`mutation:${ref}`);
				if (ref === refs.internal.bootstrap.issueZipUploadUrl) {
					return { uploadUrl: "https://example/upload" };
				}
				return null;
			}),
			storage: {
				get: vi.fn(),
			},
		};

		await invokeHandler(buildArchive, ctx, {
			bootstrapId: "bootstrap-1",
			convexSecret: "secret",
			vaultName: "vault",
		});

		expect(calls.indexOf(`action:${refs.internal.yjsSync._snapshotUpdates}`)).toBeGreaterThan(-1);
		expect(calls.indexOf(`query:${refs.internal.bootstrap._readSnapshot}`)).toBeGreaterThan(
			calls.indexOf(`action:${refs.internal.yjsSync._snapshotUpdates}`),
		);
	});

	it("handles missing Yjs state without failing build", async () => {
		mockZipUpload();
		const ctx = {
			runQuery: vi.fn(async (ref: string) => {
				if (ref === refs.internal.yjsSync._listDocIdsWithPendingUpdates) {
					return [];
				}
				if (ref === refs.internal.bootstrap._readSnapshot) {
					return {
						files: [{ path: "notes/orphan.md", isText: true, sizeBytes: 10 }],
					};
				}
				return null;
			}),
			runAction: vi.fn(async (ref: string) => {
				if (ref === refs.api.yjsSync.init) {
					return { update: new ArrayBuffer(0), serverStateVector: new ArrayBuffer(0) };
				}
				return null;
			}),
			runMutation: vi.fn(async (ref: string) => {
				if (ref === refs.internal.bootstrap.issueZipUploadUrl) {
					return { uploadUrl: "https://example/upload" };
				}
				return null;
			}),
			storage: {
				get: vi.fn(),
			},
		};

		await expect(
			invokeHandler(buildArchive, ctx, {
				bootstrapId: "bootstrap-1",
				convexSecret: "secret",
				vaultName: "vault",
			}),
		).resolves.toBeUndefined();

		expect(ctx.runMutation).toHaveBeenCalledWith(
			refs.internal.bootstrap.finalizeArchive,
			expect.any(Object),
		);
	});
});
