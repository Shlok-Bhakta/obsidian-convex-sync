const fallbackClientIds = new WeakMap<object, string>();

export function resolveClientId(host: {
	getPresenceSessionId(): string | null | undefined;
}): string {
	const direct = host.getPresenceSessionId()?.trim();
	if (direct) {
		return direct;
	}

	let fallback = fallbackClientIds.get(host as object);
	if (!fallback) {
		fallback = crypto.randomUUID();
		fallbackClientIds.set(host as object, fallback);
		console.warn(
			"[obsidian-convex-sync] Missing presence session id at runtime, using fallback client id",
		);
	}
	return fallback;
}
