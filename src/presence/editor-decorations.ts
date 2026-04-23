import { type Extension, type Text, RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
	Decoration,
	EditorView,
	type DecorationSet,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { MarkdownView, editorInfoField, type App } from "obsidian";
import { shortClientId } from "./formatting";
import type { PresenceRow } from "./types";

type ClientColors = {
	caret: string;
	selection: string;
};

type PresenceDecorationsController = {
	extension: Extension;
	setRows(rows: PresenceRow[]): void;
	refresh(): void;
};

const setPresenceRowsEffect = StateEffect.define<PresenceRow[]>();

class RemoteCaretWidget extends WidgetType {
	constructor(
		private readonly label: string,
		private readonly colors: ClientColors,
	) {
		super();
	}

	eq(other: RemoteCaretWidget): boolean {
		return other.label === this.label && other.colors.caret === this.colors.caret;
	}

	toDOM(): HTMLElement {
		const wrap = document.createElement("span");
		wrap.className = "convex-sync-remote-caret";
		wrap.style.setProperty("--convex-sync-caret-color", this.colors.caret);
		wrap.setAttribute("aria-hidden", "true");
		wrap.contentEditable = "false";

		const bar = document.createElement("span");
		bar.className = "convex-sync-remote-caret-bar";
		wrap.append(bar);

		const label = document.createElement("span");
		label.className = "convex-sync-remote-caret-label";
		label.textContent = this.label;
		wrap.append(label);

		return wrap;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function hashClientId(value: string): number {
	let hash = 0;
	for (let i = 0; i < value.length; i += 1) {
		hash = (hash * 33 + value.charCodeAt(i)) >>> 0;
	}
	return hash;
}

function colorsForClient(clientId: string): ClientColors {
	const hue = hashClientId(clientId) % 360;
	return {
		caret: `hsl(${hue} 78% 58%)`,
		selection: `hsla(${hue}, 85%, 60%, 0.22)`,
	};
}

function clampDocPosition(doc: Text, pos: { line: number; ch: number }): number {
	const lineNumber = Math.max(1, Math.min(doc.lines, Math.floor(pos.line) + 1));
	const line = doc.line(lineNumber);
	const ch = Math.max(0, Math.min(line.length, Math.floor(pos.ch)));
	return line.from + ch;
}

function buildDecorations(
	view: EditorView,
	app: App,
	localClientId: string,
	rows: readonly PresenceRow[],
): DecorationSet {
	const info = view.state.field(editorInfoField, false);
	if (!info?.editor) {
		return Decoration.none;
	}
	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView?.file || activeView.editor !== info.editor) {
		return Decoration.none;
	}
	const visibleRows = rows
		.filter(
			(row) =>
				row.clientId !== localClientId &&
				row.openFilePath === activeView.file?.path,
		)
		.sort((a, b) => a.clientId.localeCompare(b.clientId));
	if (visibleRows.length === 0) {
		return Decoration.none;
	}

	const builder = new RangeSetBuilder<Decoration>();
	for (const row of visibleRows) {
		const colors = colorsForClient(row.clientId);
		const selectionFrom = clampDocPosition(view.state.doc, row.cursor.from);
		const selectionTo = clampDocPosition(view.state.doc, row.cursor.to);
		const caretPos = clampDocPosition(view.state.doc, row.cursor.head);

		if (selectionFrom !== selectionTo) {
			builder.add(
				selectionFrom,
				selectionTo,
				Decoration.mark({
					class: "convex-sync-remote-selection",
					attributes: {
						style: `--convex-sync-selection-color: ${colors.selection}; --convex-sync-caret-color: ${colors.caret};`,
					},
				}),
			);
		}

		builder.add(
			caretPos,
			caretPos,
			Decoration.widget({
				widget: new RemoteCaretWidget(shortClientId(row.clientId), colors),
				side: 1,
			}),
		);
	}

	return builder.finish();
}

export function createPresenceDecorations(
	app: App,
	localClientId: string,
): PresenceDecorationsController {
	const editorViews = new Set<EditorView>();
	let latestRows: PresenceRow[] = [];

	const extension = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			private rows: PresenceRow[];

			constructor(private readonly view: EditorView) {
				editorViews.add(view);
				this.rows = latestRows;
				this.decorations = buildDecorations(view, app, localClientId, this.rows);
			}

			update(update: ViewUpdate): void {
				let shouldRebuild =
					update.docChanged ||
					update.selectionSet ||
					update.viewportChanged ||
					update.focusChanged;
				for (const tr of update.transactions) {
					for (const effect of tr.effects) {
						if (effect.is(setPresenceRowsEffect)) {
							this.rows = effect.value;
							shouldRebuild = true;
						}
					}
				}
				if (shouldRebuild) {
					this.decorations = buildDecorations(
						this.view,
						app,
						localClientId,
						this.rows,
					);
				}
			}

			destroy(): void {
				editorViews.delete(this.view);
			}
		},
		{
			decorations: (value) => value.decorations,
		},
	);

	const dispatchRows = (): void => {
		for (const view of editorViews) {
			view.dispatch({ effects: setPresenceRowsEffect.of(latestRows) });
		}
	};

	return {
		extension,
		setRows(rows) {
			latestRows = rows;
			dispatchRows();
		},
		refresh() {
			dispatchRows();
		},
	};
}
