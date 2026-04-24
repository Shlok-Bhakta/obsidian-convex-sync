import { mergeTextContent } from "./fileSyncEngine";

export type TextCommitDecision =
	| { kind: "fast_forward" }
	| { kind: "merged"; mergedText: string }
	| { kind: "conflict"; conflictType: "text" | "delete" | "stale_base" };

export function decideTextCommit(input: {
	headRevision: number;
	baseRevision: number;
	deleted: boolean;
	baseText: string | null;
	currentText: string | null;
	incomingText: string | null;
}): TextCommitDecision {
	if (input.deleted) {
		return { kind: "conflict", conflictType: "delete" };
	}
	if (input.headRevision === input.baseRevision) {
		return { kind: "fast_forward" };
	}
	if (input.baseText === null || input.currentText === null || input.incomingText === null) {
		return { kind: "conflict", conflictType: "stale_base" };
	}
	const merged = mergeTextContent(input.baseText, input.currentText, input.incomingText);
	if (!merged.ok) {
		return { kind: "conflict", conflictType: "text" };
	}
	return { kind: "merged", mergedText: merged.mergedText };
}

export function decideBinaryCommit(input: {
	headRevision: number;
	baseRevision: number;
	deleted: boolean;
}): { kind: "fast_forward" } | { kind: "conflict"; conflictType: "binary" | "delete" } {
	if (input.deleted) {
		return { kind: "conflict", conflictType: "delete" };
	}
	if (input.headRevision === input.baseRevision) {
		return { kind: "fast_forward" };
	}
	return { kind: "conflict", conflictType: "binary" };
}

export function decideRenameCommit(input: {
	headRevision: number;
	baseRevision: number;
	deleted: boolean;
}): { kind: "fast_forward" } | { kind: "conflict"; conflictType: "rename" | "delete" } {
	if (input.deleted) {
		return { kind: "conflict", conflictType: "delete" };
	}
	if (input.headRevision === input.baseRevision) {
		return { kind: "fast_forward" };
	}
	return { kind: "conflict", conflictType: "rename" };
}

export function decideDeleteCommit(input: {
	headRevision: number;
	baseRevision: number;
	deleted: boolean;
}): { kind: "fast_forward" } | { kind: "conflict"; conflictType: "delete" } {
	if (input.deleted) {
		return { kind: "conflict", conflictType: "delete" };
	}
	if (input.headRevision === input.baseRevision) {
		return { kind: "fast_forward" };
	}
	return { kind: "conflict", conflictType: "delete" };
}
