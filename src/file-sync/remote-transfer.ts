import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

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
	const response = await fetch(signed.url, { method: "GET", cache: "no-store" });
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
	const uploadResponse = await fetch(issued.uploadUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/octet-stream",
		},
		body: blob,
	});
	if (!uploadResponse.ok) {
		throw new Error(`Upload failed for ${path}: HTTP ${uploadResponse.status}`);
	}
	const payload = (await uploadResponse.json()) as { storageId?: string };
	if (!payload.storageId) {
		throw new Error(`Upload did not return storageId for ${path}`);
	}
	const finalized = await client.mutation(api.fileSync.finalizeUpload, {
		convexSecret: secret,
		path,
		storageId: payload.storageId as never,
		contentHash,
		updatedAtMs,
		sizeBytes: blob.size,
		clientId,
	});
	if (!finalized.ok && finalized.reason === "stale_write") {
		return "stale_write";
	}
	return "ok";
}
