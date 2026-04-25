type MergeTextsArgs = {
	base: string;
	local: string;
	remote: string;
	localClientId: string;
	remoteClientId: string;
};

export type MergeResult = {
	text: string;
	changed: boolean;
	usedFallbackBackup: boolean;
};

type DiffOp = {
	type: "equal" | "insert" | "delete";
	text: string;
};

type TextEdit = {
	start: number;
	end: number;
	insert: string;
};

type AnchoredInsert = {
	anchor: number;
	text: string;
	clientId: string;
	source: "local" | "remote";
	order: number;
};

export function mergeTexts({
	base,
	local,
	remote,
	localClientId,
	remoteClientId,
}: MergeTextsArgs): MergeResult {
	if (local === remote) {
		return {
			text: local,
			changed: false,
			usedFallbackBackup: false,
		};
	}

	const localEdits = editsFromBase(base, local);
	const remoteEdits = editsFromBase(base, remote);
	const deleted = new Array<boolean>(base.length).fill(false);
	const insertsByAnchor = new Map<number, AnchoredInsert[]>();

	addEdits(localEdits, deleted, insertsByAnchor, localClientId, "local");
	addEdits(remoteEdits, deleted, insertsByAnchor, remoteClientId, "remote");

	for (const inserts of insertsByAnchor.values()) {
		inserts.sort(compareAnchoredInsert);
	}

	let merged = "";
	for (let index = 0; index <= base.length; index += 1) {
		const inserts = insertsByAnchor.get(index);
		if (inserts) {
			for (const insert of inserts) {
				merged += insert.text;
			}
		}
		if (index < base.length && !deleted[index]) {
			merged += base[index] ?? "";
		}
	}

	return {
		text: merged,
		changed: merged !== local || merged !== remote,
		usedFallbackBackup:
			base.length === 0 && local !== remote && local.length > 0 && remote.length > 0,
	};
}

function addEdits(
	edits: TextEdit[],
	deleted: boolean[],
	insertsByAnchor: Map<number, AnchoredInsert[]>,
	clientId: string,
	source: "local" | "remote",
): void {
	for (let index = 0; index < edits.length; index += 1) {
		const edit = edits[index];
		if (!edit) {
			continue;
		}
		for (let baseIndex = edit.start; baseIndex < edit.end; baseIndex += 1) {
			deleted[baseIndex] = true;
		}
		if (edit.insert.length === 0) {
			continue;
		}
		const inserts = insertsByAnchor.get(edit.start) ?? [];
		inserts.push({
			anchor: edit.start,
			text: edit.insert,
			clientId,
			source,
			order: index,
		});
		insertsByAnchor.set(edit.start, inserts);
	}
}

function editsFromBase(base: string, target: string): TextEdit[] {
	const ops = diffStrings(base, target);
	const edits: TextEdit[] = [];
	let baseIndex = 0;
	let pendingStart: number | null = null;
	let pendingDeleteCount = 0;
	let pendingInsert = "";

	const flush = () => {
		if (pendingStart === null) {
			return;
		}
		edits.push({
			start: pendingStart,
			end: pendingStart + pendingDeleteCount,
			insert: pendingInsert,
		});
		pendingStart = null;
		pendingDeleteCount = 0;
		pendingInsert = "";
	};

	for (const op of ops) {
		switch (op.type) {
			case "equal":
				flush();
				baseIndex += op.text.length;
				break;
			case "delete":
				if (pendingStart === null) {
					pendingStart = baseIndex;
				}
				pendingDeleteCount += op.text.length;
				baseIndex += op.text.length;
				break;
			case "insert":
				if (pendingStart === null) {
					pendingStart = baseIndex;
				}
				pendingInsert += op.text;
				break;
		}
	}

	flush();
	return edits;
}

function diffStrings(previous: string, next: string): DiffOp[] {
	if (previous === next) {
		return [{ type: "equal", text: previous }];
	}
	return collapseDiffOps(diffCore(previous, next));
}

function collapseDiffOps(ops: DiffOp[]): DiffOp[] {
	const collapsed: DiffOp[] = [];
	for (const op of ops) {
		if (op.text.length === 0) {
			continue;
		}
		const previous = collapsed[collapsed.length - 1];
		if (previous?.type === op.type) {
			previous.text += op.text;
			continue;
		}
		collapsed.push({ ...op });
	}
	return collapsed;
}

function compareAnchoredInsert(left: AnchoredInsert, right: AnchoredInsert): number {
	if (left.clientId !== right.clientId) {
		return left.clientId.localeCompare(right.clientId);
	}
	if (left.source !== right.source) {
		return left.source.localeCompare(right.source);
	}
	return left.order - right.order;
}

function diffCore(previous: string, next: string): DiffOp[] {
	if (previous === next) {
		return previous.length === 0 ? [] : [{ type: "equal", text: previous }];
	}
	if (previous.length === 0) {
		return next.length === 0 ? [] : [{ type: "insert", text: next }];
	}
	if (next.length === 0) {
		return [{ type: "delete", text: previous }];
	}

	const prefixLength = commonPrefixLength(previous, next);
	const suffixLength = commonSuffixLength(previous, next, prefixLength);
	if (prefixLength > 0 || suffixLength > 0) {
		const ops: DiffOp[] = [];
		if (prefixLength > 0) {
			ops.push({ type: "equal", text: previous.slice(0, prefixLength) });
		}
		ops.push(
			...diffCore(
				previous.slice(prefixLength, previous.length - suffixLength),
				next.slice(prefixLength, next.length - suffixLength),
			),
		);
		if (suffixLength > 0) {
			ops.push({ type: "equal", text: previous.slice(previous.length - suffixLength) });
		}
		return collapseDiffOps(ops);
	}

	const anchor = longestCommonSubstring(previous, next);
	if (anchor.length < 3) {
		return [
			{ type: "delete", text: previous },
			{ type: "insert", text: next },
		];
	}

	return collapseDiffOps([
		...diffCore(previous.slice(0, anchor.previousIndex), next.slice(0, anchor.nextIndex)),
		{
			type: "equal",
			text: previous.slice(
				anchor.previousIndex,
				anchor.previousIndex + anchor.length,
			),
		},
		...diffCore(
			previous.slice(anchor.previousIndex + anchor.length),
			next.slice(anchor.nextIndex + anchor.length),
		),
	]);
}

function commonPrefixLength(left: string, right: string): number {
	let index = 0;
	while (index < left.length && index < right.length && left[index] === right[index]) {
		index += 1;
	}
	return index;
}

function commonSuffixLength(left: string, right: string, prefixLength: number): number {
	let offset = 0;
	while (
		offset < left.length - prefixLength &&
		offset < right.length - prefixLength &&
		left[left.length - 1 - offset] === right[right.length - 1 - offset]
	) {
		offset += 1;
	}
	return offset;
}

function longestCommonSubstring(
	previous: string,
	next: string,
): { previousIndex: number; nextIndex: number; length: number } {
	const table = Array.from({ length: previous.length + 1 }, () =>
		new Array<number>(next.length + 1).fill(0),
	);
	let bestLength = 0;
	let bestPreviousIndex = 0;
	let bestNextIndex = 0;

	for (let previousIndex = 1; previousIndex <= previous.length; previousIndex += 1) {
		for (let nextIndex = 1; nextIndex <= next.length; nextIndex += 1) {
			if (previous[previousIndex - 1] !== next[nextIndex - 1]) {
				continue;
			}
			const length = (table[previousIndex - 1]?.[nextIndex - 1] ?? 0) + 1;
			table[previousIndex]![nextIndex] = length;
			if (length <= bestLength) {
				continue;
			}
			bestLength = length;
			bestPreviousIndex = previousIndex - length;
			bestNextIndex = nextIndex - length;
		}
	}

	return {
		previousIndex: bestPreviousIndex,
		nextIndex: bestNextIndex,
		length: bestLength,
	};
}
