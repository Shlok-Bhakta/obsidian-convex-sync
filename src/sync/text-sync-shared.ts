import { normalizePath } from "obsidian";
import * as Y from "yjs";

export function textDocIdForPath(vaultName: string, path: string): string {
	return `${vaultName}::${normalizePath(path)}`;
}

export function createTextYDoc(content: string): Y.Doc {
	const doc = new Y.Doc();
	if (content.length > 0) {
		doc.getText("content").insert(0, content);
	}
	return doc;
}

export function textByteLength(content: string): number {
	return new TextEncoder().encode(content).length;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function sha256Utf8(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return toHex(digest);
}
