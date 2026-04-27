"use node";

import archiver from "archiver";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import * as Y from "yjs";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction } from "./_generated/server";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

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
			const docsWithPendingUpdates = await ctx.runQuery(
				internal.yjsSync._listDocIdsWithPendingUpdates,
				{},
			);
			for (const docId of docsWithPendingUpdates) {
				await ctx.runAction(internal.yjsSync._snapshotUpdates, { docId });
			}

			const snapshot = await ctx.runQuery(internal.bootstrap._readSnapshot, {
				convexSecret: args.convexSecret,
			});

			let filesProcessed = 0;
			let bytesProcessed = 0;
			const chunkInterval = 8;
			const vaultPrefix = `${args.vaultName}::`;
			const zipRoot = sanitizeVaultFolder(args.vaultName);

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

			for (const row of snapshot.files) {
				try {
					if (row.isText) {
						const doc = new Y.Doc();
						try {
							const initial = await ctx.runAction(api.yjsSync.init, {
								convexSecret: args.convexSecret,
								docId: `${vaultPrefix}${row.path}`,
								stateVector: toArrayBuffer(Y.encodeStateVector(doc)),
							});
							if (
								initial &&
								typeof initial === "object" &&
								"update" in initial &&
								(initial as { update?: ArrayBuffer | Uint8Array }).update
							) {
								const raw = (initial as { update: ArrayBuffer | Uint8Array }).update;
								const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
								if (u8.byteLength > 0) {
									Y.applyUpdate(doc, u8);
								}
							}
							const text = doc.getText("content").toString();
							archive.append(Buffer.from(text, "utf8"), { name: zipEntryPath(zipRoot, row.path) });
						} finally {
							doc.destroy();
						}
					} else {
						if (!row.storageId) {
							continue;
						}
						const blob = await ctx.storage.get(row.storageId);
						if (!blob) {
							continue;
						}
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
				} catch (err) {
					console.warn(`[bootstrap] skipping ${row.path}:`, err);
				}
				filesProcessed += 1;
				bytesProcessed += row.sizeBytes;
				if (filesProcessed % chunkInterval === 0) {
					await ctx.runMutation(internal.bootstrap.updateProgress, {
						bootstrapId: args.bootstrapId,
						phase: `Collecting vault files (${filesProcessed}/${snapshot.files.length})`,
						filesProcessed,
						bytesProcessed,
					});
				}
			}

			await ctx.runMutation(internal.bootstrap.updateProgress, {
				bootstrapId: args.bootstrapId,
				phase: "Writing archive",
				filesProcessed,
				bytesProcessed,
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
