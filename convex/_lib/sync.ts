import { v } from "convex/values";

export const docKindValidator = v.union(
	v.literal("text"),
	v.literal("binary"),
	v.literal("folder"),
);

export type DocKind = "text" | "binary" | "folder";

const BINARY_EXTENSIONS = new Set([
	"7z",
	"aac",
	"avi",
	"avif",
	"bmp",
	"class",
	"doc",
	"docx",
	"eot",
	"epub",
	"exe",
	"gif",
	"gz",
	"ico",
	"jar",
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

export function normalizeVaultPath(input: string): string {
	const normalized = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (normalized.includes("..")) {
		throw new Error("Path traversal is not allowed.");
	}
	return normalized;
}

export function legacyDocIdForPath(path: string): string {
	return `legacy:${normalizeVaultPath(path)}`;
}

export function isBinaryPath(path: string): boolean {
	const normalized = normalizeVaultPath(path);
	const lastDot = normalized.lastIndexOf(".");
	if (lastDot < 0) {
		return false;
	}
	return BINARY_EXTENSIONS.has(normalized.slice(lastDot + 1).toLowerCase());
}
