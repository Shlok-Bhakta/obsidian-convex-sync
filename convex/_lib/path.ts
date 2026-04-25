import { ConvexError } from "convex/values";

export function normalizeVaultPath(input: string): string {
	const normalized = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (normalized === "") {
		throw new ConvexError("Path is required.");
	}
	if (normalized.split("/").includes("..")) {
		throw new ConvexError("Path traversal is not allowed.");
	}
	return normalized;
}
