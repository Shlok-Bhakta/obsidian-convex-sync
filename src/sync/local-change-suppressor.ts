import { normalizePath } from "obsidian";

const suppressedPaths = new Map<string, number>();

function retain(path: string): string {
	return normalizePath(path);
}

export function isLocalChangeSuppressed(path: string): boolean {
	return suppressedPaths.has(retain(path));
}

export async function withSuppressedLocalChange<T>(
	path: string,
	work: () => Promise<T>,
): Promise<T> {
	const key = retain(path);
	suppressedPaths.set(key, (suppressedPaths.get(key) ?? 0) + 1);
	try {
		return await work();
	} finally {
		const nextCount = (suppressedPaths.get(key) ?? 1) - 1;
		if (nextCount <= 0) {
			suppressedPaths.delete(key);
		} else {
			suppressedPaths.set(key, nextCount);
		}
	}
}
