export function formatPos(p: { line: number; ch: number }): string {
	return `L${p.line}:${p.ch}`;
}

export function formatCursor(c: {
	anchor: { line: number; ch: number };
	head: { line: number; ch: number };
	from: { line: number; ch: number };
	to: { line: number; ch: number };
}): string {
	return `a ${formatPos(c.anchor)} · h ${formatPos(c.head)} · ${formatPos(c.from)}→${formatPos(c.to)}`;
}

export function shortClientId(id: string): string {
	if (id.length <= 12) {
		return id;
	}
	return `${id.slice(0, 8)}…`;
}
