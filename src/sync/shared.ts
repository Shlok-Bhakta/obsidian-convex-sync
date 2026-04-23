import { normalizePath, TAbstractFile, TFile, TFolder } from "obsidian";
import { matchesSyncIgnorePath } from "../sync-ignore";

const BINARY_EXTENSIONS = new Set([
	"7z",
	"aac",
	"avi",
	"avif",
	"bmp",
	"doc",
	"docx",
	"eot",
	"epub",
	"exe",
	"gif",
	"gz",
	"ico",
	"jpeg",
	"jpg",
	"m4a",
	"mov",
	"mp3",
	"mp4",
	"ogg",
	"otf",
	"pdf",
	"png",
	"ppt",
	"pptx",
	"rar",
	"sqlite",
	"tar",
	"tif",
	"tiff",
	"ttf",
	"wav",
	"webm",
	"webp",
	"woff",
	"woff2",
	"xls",
	"xlsx",
	"zip",
]);

export const LIVE_SYNC_TRASH_ROOT = ".trash";

export type SyncKind = "text" | "binary" | "folder";

export function normalizeVaultPath(path: string): string {
	return normalizePath(path.trim().replace(/^\/+/, ""));
}

export function folderPathForFile(filePath: string): string | null {
	const slash = filePath.lastIndexOf("/");
	return slash < 0 ? null : filePath.slice(0, slash);
}

export function isManagedSyncPath(path: string, ignorePaths: string[] = []): boolean {
	const normalized = normalizeVaultPath(path);
	return (
		normalized !== "" &&
		!normalized.startsWith(`${LIVE_SYNC_TRASH_ROOT}/`) &&
		normalized !== LIVE_SYNC_TRASH_ROOT &&
		!normalized.startsWith(".obsidian/") &&
		normalized !== ".obsidian" &&
		!matchesSyncIgnorePath(normalized, ignorePaths)
	);
}

export function kindForAbstractFile(file: TAbstractFile): SyncKind {
	if (file instanceof TFolder) {
		return "folder";
	}
	if (file instanceof TFile) {
		return isBinaryPath(file.path) ? "binary" : "text";
	}
	return "binary";
}

export function isBinaryPath(path: string): boolean {
	const normalized = normalizeVaultPath(path);
	const dot = normalized.lastIndexOf(".");
	if (dot < 0) {
		return false;
	}
	return BINARY_EXTENSIONS.has(normalized.slice(dot + 1).toLowerCase());
}

export function randomDocId(): string {
	return crypto.randomUUID();
}

export async function sha256Bytes(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export function toUint8Array(bytes: ArrayBuffer | Uint8Array): Uint8Array {
	return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}
