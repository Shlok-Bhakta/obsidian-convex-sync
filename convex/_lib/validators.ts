import { v } from "convex/values";

export const editorPosition = v.object({
	line: v.number(),
	ch: v.number(),
});

export const editorCursor = v.object({
	anchor: editorPosition,
	head: editorPosition,
	from: editorPosition,
	to: editorPosition,
});

export const emptyCursor = {
	anchor: { line: 0, ch: 0 },
	head: { line: 0, ch: 0 },
	from: { line: 0, ch: 0 },
	to: { line: 0, ch: 0 },
};
