import { ConvexError } from "convex/values";

function normalizePathText(input: string): string {
	return input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

export function normalizeVaultPath(input: string): string {
	const normalized = normalizePathText(input);
	if (normalized === "") {
		throw new ConvexError("Path is required.");
	}
	if (normalized.split("/").includes("..")) {
		throw new ConvexError("Path traversal is not allowed.");
	}
	return normalized;
}

export function normalizeOptionalVaultPath(input: string): string | null {
	const normalized = normalizePathText(input);
	if (normalized === "") {
		return null;
	}
	return normalizeVaultPath(normalized);
}
