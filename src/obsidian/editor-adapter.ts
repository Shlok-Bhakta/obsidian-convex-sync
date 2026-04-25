import type { Editor } from "obsidian";
import type { OpenDocumentSession } from "../core/sync-engine";
import type { TextSplice } from "../core/doc-session";

export type EditorAdapter = {
	handleEditorChange(editor: Pick<Editor, "getValue">): Promise<void>;
	applyRemoteText(editor: Pick<Editor, "getValue" | "setValue">, text: string): void;
	isApplyingRemote(): boolean;
};

export function createEditorAdapter(session: OpenDocumentSession): EditorAdapter {
	let applyingRemote = false;

	return {
		async handleEditorChange(editor: Pick<Editor, "getValue">): Promise<void> {
			if (applyingRemote) {
				console.debug("[adapter] skipped crdt-originated transaction", {
					docId: session.docId,
				});
				return;
			}
			const previous = session.getTextSnapshot();
			const next = editor.getValue();
			const splice = diffToSplice(previous, next);
			if (!splice) {
				return;
			}
			console.info("[adapter] local splice", {
				docId: session.docId,
				position: splice.pos,
				delCount: splice.del,
				insLength: splice.ins.length,
			});
			await session.applyLocalChange([splice]);
		},

		applyRemoteText(editor: Pick<Editor, "getValue" | "setValue">, text: string): void {
			if (editor.getValue() === text) {
				return;
			}
			applyingRemote = true;
			try {
				editor.setValue(text);
				console.info("[adapter] remote patch applied", {
					docId: session.docId,
					patchCount: 1,
					editorLengthAfter: text.length,
				});
			} finally {
				queueMicrotask(() => {
					applyingRemote = false;
				});
			}
		},

		isApplyingRemote(): boolean {
			return applyingRemote;
		},
	};
}

export function diffToSplice(previous: string, next: string): TextSplice | null {
	if (previous === next) {
		return null;
	}

	let prefix = 0;
	const minLength = Math.min(previous.length, next.length);
	while (prefix < minLength && previous[prefix] === next[prefix]) {
		prefix += 1;
	}

	let previousSuffix = previous.length;
	let nextSuffix = next.length;
	while (
		previousSuffix > prefix &&
		nextSuffix > prefix &&
		previous[previousSuffix - 1] === next[nextSuffix - 1]
	) {
		previousSuffix -= 1;
		nextSuffix -= 1;
	}

	return {
		pos: prefix,
		del: previousSuffix - prefix,
		ins: next.slice(prefix, nextSuffix),
	};
}
