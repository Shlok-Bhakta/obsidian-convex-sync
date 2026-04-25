import { describe, expect, test, vi } from "vitest";
import type { OpenDocumentSession } from "../core/sync-engine";
import { createEditorAdapter, diffToSplice } from "./editor-adapter";

describe("editor adapter", () => {
	test("keystroke_produces_splice_not_full_replace", () => {
		expect(diffToSplice("abc", "abxc")).toEqual({
			pos: 2,
			del: 0,
			ins: "x",
		});
	});

	test("delete_produces_splice_with_del_count", () => {
		expect(diffToSplice("abcdef", "abf")).toEqual({
			pos: 2,
			del: 3,
			ins: "",
		});
	});

	test("empty_transaction_is_ignored", async () => {
		const session = fakeSession("same");
		const adapter = createEditorAdapter(session);

		await adapter.handleEditorChange({ getValue: () => "same" });

		expect(session.applyLocalChange).not.toHaveBeenCalled();
	});

	test("remote_patch_updates_editor_text", () => {
		const editor = fakeEditor("hello");
		const adapter = createEditorAdapter(fakeSession("hello"));

		adapter.applyRemoteText(editor, "hello!");

		expect(editor.getValue()).toBe("hello!");
	});

	test("crdt_apply_annotation_blocks_re_entry", async () => {
		const editor = fakeEditor("hello");
		const session = fakeSession("hello");
		const adapter = createEditorAdapter(session);

		adapter.applyRemoteText(editor, "remote");
		await adapter.handleEditorChange(editor);

		expect(session.applyLocalChange).not.toHaveBeenCalled();
	});
});

function fakeSession(text: string): OpenDocumentSession {
	return {
		docId: "doc-a",
		path: "a.md",
		getTextSnapshot: () => text,
		applyLocalChange: vi.fn(async () => undefined),
		close: vi.fn(),
	};
}

function fakeEditor(initial: string): {
	getValue(): string;
	setValue(value: string): void;
} {
	let value = initial;
	return {
		getValue: () => value,
		setValue: (next) => {
			value = next;
		},
	};
}
