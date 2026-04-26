import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

const MAX_CONVEX_BYTES_ARG_BYTES = 900_000;

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return toHex(digest);
}

export async function readRemoteFileBytes(
	client: ConvexHttpClient,
	secret: string,
	path: string,
): Promise<{ bytes: ArrayBuffer; updatedAtMs: number } | null> {
	const signed = await client.query(api.fileSync.getDownloadUrl, {
		convexSecret: secret,
		path,
	});
	if (!signed) {
		return null;
	}
	const response = await fetchWithPathContext(
		signed.url,
		{ method: "GET", cache: "no-store" },
		`Failed downloading ${path}`,
	);
	if (!response.ok) {
		throw new Error(`Failed downloading ${path}: HTTP ${response.status}`);
	}
	const bytes = await response.arrayBuffer();
	return { bytes, updatedAtMs: signed.updatedAtMs };
}

export async function uploadLocalFile(
	client: ConvexHttpClient,
	secret: string,
	clientId: string,
	path: string,
	bytes: ArrayBuffer,
	updatedAtMs: number,
	options: { force?: boolean } = {},
): Promise<"ok" | "stale_write"> {
	const blob = new Blob([bytes], { type: "application/octet-stream" });
	const contentHash = await sha256Bytes(bytes);
	const issued = await client.mutation(api.fileSync.issueUploadUrl, {
		convexSecret: secret,
		path,
		contentHash,
		updatedAtMs,
		sizeBytes: blob.size,
		clientId,
	});
	let finalized: FinalizeUploadResult;
	try {
		const uploadResponse = await fetchWithPathContext(
			issued.uploadUrl,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/octet-stream",
				},
				body: blob,
			},
			`Upload failed for ${path}`,
		);
		if (!uploadResponse.ok) {
			throw new Error(`Upload failed for ${path}: HTTP ${uploadResponse.status}`);
		}
		const payload = (await uploadResponse.json()) as { storageId?: string };
		if (!payload.storageId) {
			throw new Error(`Upload did not return storageId for ${path}`);
		}
		finalized = await finalizeUploadedFile(client, {
			convexSecret: secret,
			path,
			storageId: payload.storageId as never,
			contentHash,
			updatedAtMs,
			sizeBytes: blob.size,
			clientId,
			force: options.force,
		});
	} catch (error) {
		if (blob.size > MAX_CONVEX_BYTES_ARG_BYTES) {
			throw error;
		}
		console.warn("[file-sync] signed upload failed, falling back to Convex action", {
			path,
			message: error instanceof Error ? error.message : String(error),
		});
		finalized = (await client.action(api.fileSync.uploadFileBytes, {
			convexSecret: secret,
			path,
			bytes,
			contentHash,
			updatedAtMs,
			sizeBytes: blob.size,
			clientId,
			force: options.force,
		})) as FinalizeUploadResult;
	}
	if (!finalized.ok && finalized.reason === "stale_write") {
		return "stale_write";
	}
	return "ok";
}

type FinalizeUploadArgs = {
	convexSecret: string;
	path: string;
	storageId: never;
	contentHash: string;
	updatedAtMs: number;
	sizeBytes: number;
	clientId: string;
	force?: boolean;
};

type FinalizeUploadResult = { ok: true } | { ok: false; reason: "stale_write" };

async function finalizeUploadedFile(
	client: ConvexHttpClient,
	args: FinalizeUploadArgs,
): Promise<FinalizeUploadResult> {
	try {
		return (await client.mutation(
			api.fileSync.finalizeUpload,
			args,
		)) as FinalizeUploadResult;
	} catch (error) {
		if (!args.force || !isUnknownForceArgError(error)) {
			throw error;
		}
		const { force: _force, ...retryArgs } = args;
		return (await client.mutation(
			api.fileSync.finalizeUpload,
			retryArgs,
		)) as FinalizeUploadResult;
	}
}

function isUnknownForceArgError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("force") && message.includes("Unexpected");
}

async function fetchWithPathContext(
	input: RequestInfo | URL,
	init: RequestInit,
	context: string,
): Promise<Response> {
	try {
		return await fetch(input, init);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${context}: ${message}`);
	}
}
