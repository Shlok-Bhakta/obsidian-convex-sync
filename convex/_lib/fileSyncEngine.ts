export type TextMergeResult =
	| { ok: true; mergedText: string }
	| { ok: false; reason: "conflict" };

type ChangeSpan = {
	start: number;
	baseEnd: number;
	targetEnd: number;
	targetSlice: string;
	unchanged: boolean;
};

export type CompactionDecisionInput = {
	opsSinceSnapshot: number;
	bytesSinceSnapshot: number;
	lastCompactedAtMs: number | null;
	now: number;
	hasRecentChurn: boolean;
};

export const FILE_WAL_COMPACTION_OP_THRESHOLD = 64;
export const FILE_WAL_COMPACTION_BYTES_THRESHOLD = 256 * 1024;
export const FILE_WAL_COMPACTION_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function getChangeSpan(base: string, target: string): ChangeSpan {
	let start = 0;
	const maxPrefix = Math.min(base.length, target.length);
	while (start < maxPrefix && base[start] === target[start]) {
		start += 1;
	}

	let baseEnd = base.length;
	let targetEnd = target.length;
	while (
		baseEnd > start &&
		targetEnd > start &&
		base[baseEnd - 1] === target[targetEnd - 1]
	) {
		baseEnd -= 1;
		targetEnd -= 1;
	}

	return {
		start,
		baseEnd,
		targetEnd,
		targetSlice: target.slice(start, targetEnd),
		unchanged: start === base.length && start === target.length,
	};
}

export function mergeTextContent(
	base: string,
	current: string,
	incoming: string,
): TextMergeResult {
	if (current === incoming) {
		return { ok: true, mergedText: current };
	}
	if (base === current) {
		return { ok: true, mergedText: incoming };
	}
	if (base === incoming) {
		return { ok: true, mergedText: current };
	}

	const currentChange = getChangeSpan(base, current);
	const incomingChange = getChangeSpan(base, incoming);
	if (currentChange.unchanged) {
		return { ok: true, mergedText: incoming };
	}
	if (incomingChange.unchanged) {
		return { ok: true, mergedText: current };
	}

	const currentIsInsert = currentChange.start === currentChange.baseEnd;
	const incomingIsInsert = incomingChange.start === incomingChange.baseEnd;
	const overlaps = !(
		currentChange.baseEnd < incomingChange.start ||
		incomingChange.baseEnd < currentChange.start
	);
	const sameInsertionPoint =
		currentIsInsert &&
		incomingIsInsert &&
		currentChange.start === incomingChange.start;

	if (sameInsertionPoint) {
		if (currentChange.targetSlice === incomingChange.targetSlice) {
			return { ok: true, mergedText: current };
		}
		return {
			ok: true,
			mergedText:
				base.slice(0, currentChange.start) +
				currentChange.targetSlice +
				incomingChange.targetSlice +
				base.slice(currentChange.baseEnd),
		};
	}

	if (overlaps) {
		return { ok: false, reason: "conflict" };
	}

	const ordered = [currentChange, incomingChange].sort((left, right) => left.start - right.start);
	const [first, second] = ordered;
	if (!first || !second) {
		return { ok: false, reason: "conflict" };
	}
	const mergedText =
		base.slice(0, first.start) +
		first.targetSlice +
		base.slice(first.baseEnd, second.start) +
		second.targetSlice +
		base.slice(second.baseEnd);
	return { ok: true, mergedText };
}

export function shouldCompactFileHistory(input: CompactionDecisionInput): boolean {
	if (input.opsSinceSnapshot >= FILE_WAL_COMPACTION_OP_THRESHOLD) {
		return true;
	}
	if (input.bytesSinceSnapshot >= FILE_WAL_COMPACTION_BYTES_THRESHOLD) {
		return true;
	}
	if (!input.hasRecentChurn) {
		return false;
	}
	if (input.lastCompactedAtMs === null) {
		return true;
	}
	return input.now - input.lastCompactedAtMs >= FILE_WAL_COMPACTION_STALE_MS;
}
