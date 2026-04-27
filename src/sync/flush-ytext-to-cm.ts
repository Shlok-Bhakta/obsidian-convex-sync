import type { EditorView } from "@codemirror/view";
import type { Text as YText } from "yjs";
import { MarkdownView, normalizePath, type App } from "obsidian";
import type { YSyncConfig } from "y-codemirror.next";
// Package exports block this subpath; `paths` + esbuild alias bundle the same module instance as yCollab.
import { ySyncAnnotation, ySyncFacet } from "y-internal-y-sync";

type EditorWithCm = { cm?: EditorView };

/**
 * y-codemirror only pushes Y→CM when Y.Text fires `observe` after the sync plugin exists.
 * We hydrate Y from Convex *before* registering yCollab, so the editor can stay on stale disk
 * until we explicitly replace CM from the current Y.Text (annotated so ySync does not echo CM→Y).
 */
export function flushYjsTextToActiveMarkdownEditor(
	app: App,
	expectedPath: string,
	ytext: YText,
): void {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view?.file || normalizePath(view.file.path) !== normalizePath(expectedPath)) {
		return;
	}
	if (view.getMode() !== "source") {
		return;
	}
	const cmView = (view.editor as unknown as EditorWithCm).cm;
	if (!cmView) {
		return;
	}
	let conf: YSyncConfig;
	try {
		conf = cmView.state.facet(ySyncFacet);
	} catch {
		return;
	}
	// Y.Text is string-like; eslint false positive (no-base-to-string).
	// eslint-disable-next-line @typescript-eslint/no-base-to-string -- Yjs Y.Text
	const yContent = ytext.toString();
	if (cmView.state.doc.toString() === yContent) {
		return;
	}
	cmView.dispatch({
		changes: { from: 0, to: cmView.state.doc.length, insert: yContent },
		annotations: ySyncAnnotation.of(conf),
	});
}
