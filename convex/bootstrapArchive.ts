"use node";

import archiver from "archiver";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

const FILE_PAGE_SIZE = 64;
const FILE_PAGE_MAX_BYTES = 1 * 1024 * 1024;
const PROGRESS_MIN_INTERVAL_MS = 1_500;
const PROGRESS_MIN_FILE_DELTA = 32;

type SnapshotFileRow = {
	path: string;
	isText: boolean;
	storageId?: Id<"_storage">;
	sizeBytes: number;
};

type SnapshotFilePage = {
	page: SnapshotFileRow[];
	isDone: boolean;
	continueCursor: string;
};

/** Top-level folder inside the ZIP (matches bootstrap archive naming rules). */
function sanitizeVaultFolder(vaultName: string): string {
	const s = vaultName
		.trim()
		.replace(/[^\w.-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return s || "vault";
}

function zipEntryPath(zipRoot: string, vaultRelativePath: string): string {
	const p = vaultRelativePath.replace(/^\/+/, "");
	return `${zipRoot}/${p}`;
}

/**
 * Builds a ZIP of the vault in the Node runtime.
 *
 * - **STORE** entries (no compression): still a normal `.zip`; faster and avoids
 *   double-compressing already-compressed assets (photos, PDFs, etc.).
 * - **Binaries**: each file is fully streamed to a temp file, then `archive.file()` pulls
 *   from disk. Appending a live `Blob` stream was truncating entries because archiver
 *   reads streams asynchronously after the loop moved on.
 * - **Text**: Yjs `content` is still buffered per file (one note at a time).
 * - **SHA-256** of the final ZIP is computed on the fly; upload uses a streaming POST.
 */
export const buildArchive = internalAction({
	args: {
		bootstrapId: v.id("vaultBootstraps"),
		convexSecret: v.string(),
		vaultName: v.string(),
	},
	handler: async (ctx, args) => {
		const tmpPath = join(tmpdir(), `obsidian-bootstrap-${randomBytes(16).toString("hex")}.zip`);
		const stagingPaths: string[] = [];
		try {
			let filesProcessed = 0;
			let bytesProcessed = 0;
			let filesTotal = 0;
			let bytesTotal = 0;
			const vaultPrefix = `${args.vaultName}::`;
			const zipRoot = sanitizeVaultFolder(args.vaultName);
			let lastProgressAt = 0;
			let lastProgressFiles = 0;

			const readFilePage = async (cursor: string | null): Promise<SnapshotFilePage> =>
				(await ctx.runQuery(internal.bootstrap._readFilePage, {
					convexSecret: args.convexSecret,
					paginationOpts: {
						cursor,
						numItems: FILE_PAGE_SIZE,
						maximumBytesRead: FILE_PAGE_MAX_BYTES,
					},
				})) as SnapshotFilePage;

			const reportProgress = async (phase: string, force = false): Promise<void> => {
				const now = Date.now();
				if (
					!force &&
					now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS &&
					filesProcessed - lastProgressFiles < PROGRESS_MIN_FILE_DELTA
				) {
					return;
				}
				lastProgressAt = now;
				lastProgressFiles = filesProcessed;
				await ctx.runMutation(internal.bootstrap.updateProgress, {
					bootstrapId: args.bootstrapId,
					phase,
					filesProcessed,
					bytesProcessed,
					filesTotal,
					bytesTotal,
				});
			};

			let countCursor: string | null = null;
			let countDone = false;
			while (!countDone) {
				const page = await readFilePage(countCursor);
				for (const row of page.page) {
					filesTotal += 1;
					bytesTotal += row.sizeBytes;
				}
				countCursor = page.continueCursor;
				countDone = page.isDone;
				await reportProgress(`Scanning vault files (${filesTotal})`);
			}
			await reportProgress("Collecting vault files", true);

			const hash = createHash("sha256");
			const output = createWriteStream(tmpPath);
			const hashTransform = new Transform({
				transform(chunk: Buffer, _enc, cb) {
					hash.update(chunk);
					cb(null, chunk);
				},
			});

			const archive = archiver("zip", { store: true });
			archive.on("warning", (err: Error & { code?: string }) => {
				if (err.code !== "ENOENT") {
					console.warn("[bootstrap] archiver warning:", err);
				}
			});

			archive.pipe(hashTransform).pipe(output);

			let fileCursor: string | null = null;
			let filesDone = false;
			while (!filesDone) {
				const page = await readFilePage(fileCursor);
				for (const row of page.page) {
					try {
						if (row.isText) {
							const text = await ctx.runAction(internal.yjsSync._readTextForBootstrap, {
								docId: `${vaultPrefix}${row.path}`,
							});
							archive.append(Buffer.from(text, "utf8"), {
								name: zipEntryPath(zipRoot, row.path),
							});
						} else if (row.storageId) {
							const blob = await ctx.storage.get(row.storageId);
							if (blob) {
								const staging = join(
									tmpdir(),
									`obsidian-bootstrap-staging-${randomBytes(12).toString("hex")}.bin`,
								);
								try {
									await pipeline(
										Readable.fromWeb(
											blob.stream() as import("node:stream/web").ReadableStream<Uint8Array>,
										),
										createWriteStream(staging),
									);
									archive.file(staging, { name: zipEntryPath(zipRoot, row.path) });
									stagingPaths.push(staging);
								} catch (err) {
									await unlink(staging).catch(() => {});
									throw err;
								}
							}
						}
					} catch (err) {
						console.warn(`[bootstrap] skipping ${row.path}:`, err);
					}
					filesProcessed += 1;
					bytesProcessed += row.sizeBytes;
					await reportProgress(`Collecting vault files (${filesProcessed}/${filesTotal})`);
				}
				fileCursor = page.continueCursor;
				filesDone = page.isDone;
			}

			await ctx.runMutation(internal.bootstrap.updateProgress, {
				bootstrapId: args.bootstrapId,
				phase: "Writing archive",
				filesProcessed,
				bytesProcessed,
				filesTotal,
				bytesTotal,
			});

			await archive.finalize();
			await finished(output);

			for (const p of stagingPaths) {
				await unlink(p).catch(() => {});
			}
			stagingPaths.length = 0;

			const contentHash = hash.digest("hex");
			const sizeBytes = (await stat(tmpPath)).size;

			const { uploadUrl } = await ctx.runMutation(internal.bootstrap.issueZipUploadUrl, {
				bootstrapId: args.bootstrapId,
			});

			const body = createReadStream(tmpPath);
			const uploadResponse = await fetch(
				uploadUrl,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/zip",
						"Content-Length": String(sizeBytes),
					},
					duplex: "half",
					body,
				} as unknown as RequestInit,
			);

			const uploadPayload = (await uploadResponse.json()) as { storageId?: string };
			if (!uploadResponse.ok || !uploadPayload.storageId) {
				throw new Error(
					`ZIP upload failed: HTTP ${uploadResponse.status} ${uploadResponse.statusText}`,
				);
			}

			await ctx.runMutation(internal.bootstrap.finalizeArchive, {
				bootstrapId: args.bootstrapId,
				storageId: uploadPayload.storageId as Id<"_storage">,
				contentHash,
				sizeBytes,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await ctx.runMutation(internal.bootstrap.failBuild, {
				bootstrapId: args.bootstrapId,
				message,
			});
		} finally {
			for (const p of stagingPaths) {
				await unlink(p).catch(() => {});
			}
			await unlink(tmpPath).catch(() => {});
		}
	},
});
