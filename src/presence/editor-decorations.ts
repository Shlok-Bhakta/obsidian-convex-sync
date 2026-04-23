import { type Extension, type Text, RangeSetBuilder, StateEffect } from "@codemirror/state";
import {
	Decoration,
	Direction,
	EditorView,
	type LayerMarker,
	type DecorationSet,
	ViewPlugin,
	type ViewUpdate,
	layer,
} from "@codemirror/view";
import { MarkdownView, editorInfoField, type App } from "obsidian";
import { shortClientId } from "./formatting";
import type { PresenceRow } from "./types";

type ClientColors = {
	caret: string;
	selection: string;
};

type RectLike = {
	left: number;
	right: number;
	top: number;
	bottom: number;
};

type PresenceDecorationsController = {
	extension: Extension;
	setRows(rows: PresenceRow[]): void;
	refresh(): void;
};

const setPresenceRowsEffect = StateEffect.define<PresenceRow[]>();

class RemoteCaretMarker implements LayerMarker {
	constructor(
		private readonly label: string,
		private readonly colors: ClientColors,
		private readonly left: number,
		private readonly top: number,
		private readonly height: number,
	) {
	}

	eq(other: RemoteCaretMarker): boolean {
		return (
			other.label === this.label &&
			other.colors.caret === this.colors.caret &&
			other.left === this.left &&
			other.top === this.top &&
			other.height === this.height
		);
	}

	draw(): HTMLElement {
		const wrap = document.createElement("div");
		wrap.className = "convex-sync-remote-caret";
		wrap.style.left = `${this.left}px`;
		wrap.style.top = `${this.top}px`;
		wrap.style.height = `${this.height}px`;
		wrap.style.setProperty("--convex-sync-caret-color", this.colors.caret);
		wrap.setAttribute("aria-hidden", "true");

		const label = document.createElement("span");
		label.className = "convex-sync-remote-caret-label";
		label.textContent = this.label;
		label.title = this.label;
		wrap.append(label);

		return wrap;
	}

	update(dom: HTMLElement, oldMarker: RemoteCaretMarker): boolean {
		if (!(dom instanceof HTMLDivElement)) {
			return false;
		}
		if (oldMarker.label !== this.label) {
			const label = dom.querySelector<HTMLElement>(".convex-sync-remote-caret-label");
			if (!label) {
				return false;
			}
			label.textContent = this.label;
			label.title = this.label;
		}
		dom.style.left = `${this.left}px`;
		dom.style.top = `${this.top}px`;
		dom.style.height = `${this.height}px`;
		dom.style.setProperty("--convex-sync-caret-color", this.colors.caret);
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

function getVisibleRows(
	view: EditorView,
	app: App,
	localClientId: string,
	rows: readonly PresenceRow[],
): readonly PresenceRow[] {
	const info = view.state.field(editorInfoField, false);
	if (!info?.editor) {
		return [];
	}
	const activeView = app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView?.file || activeView.editor !== info.editor) {
		return [];
	}
	return rows
		.filter(
			(row) =>
				row.clientId !== localClientId &&
				row.openFilePath === activeView.file?.path,
		)
		.sort((a, b) => a.clientId.localeCompare(b.clientId));
}

function buildSelectionDecorations(
	view: EditorView,
	app: App,
	localClientId: string,
	rows: readonly PresenceRow[],
): DecorationSet {
	const visibleRows = getVisibleRows(view, app, localClientId, rows);
	if (visibleRows.length === 0) {
		return Decoration.none;
	}

	const builder = new RangeSetBuilder<Decoration>();
	for (const row of visibleRows) {
		const colors = colorsForClient(row.clientId);
		const selectionFrom = clampDocPosition(view.state.doc, row.cursor.from);
		const selectionTo = clampDocPosition(view.state.doc, row.cursor.to);

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
	}

	return builder.finish();
}

function getLayerBase(view: EditorView): { left: number; top: number } {
	const rect = view.scrollDOM.getBoundingClientRect();
	const left =
		view.textDirection === Direction.LTR
			? rect.left
			: rect.right - view.scrollDOM.clientWidth * view.scaleX;
	return {
		left: left - view.scrollDOM.scrollLeft * view.scaleX,
		top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
	};
}

function sameLineFragment(a: RectLike | null, b: RectLike | null): boolean {
	if (!a || !b) {
		return false;
	}
	return Math.abs(a.top - b.top) < 1 && Math.abs(a.bottom - b.bottom) < 1;
}

function measureCaretRect(view: EditorView, pos: number): RectLike | null {
	const line = view.state.doc.lineAt(pos);
	const before = view.coordsAtPos(pos, -1);
	const after = view.coordsAtPos(pos, 1);
	const charBefore = pos > line.from ? view.coordsForChar(pos - 1) : null;
	const charAfter = pos < line.to ? view.coordsForChar(pos) : null;
	const beforeDirection = view.textDirectionAt(Math.max(line.from, pos - 1));
	const afterDirection = view.textDirectionAt(pos);

	const previousBoundary =
		charBefore && before && sameLineFragment(charBefore, before)
			? {
					left: beforeDirection === Direction.RTL ? charBefore.left : charBefore.right,
					right: beforeDirection === Direction.RTL ? charBefore.left : charBefore.right,
					top: before.top,
					bottom: before.bottom,
				}
			: before;

	const nextBoundary =
		charAfter && after && sameLineFragment(charAfter, after)
			? {
					left: afterDirection === Direction.RTL ? charAfter.right : charAfter.left,
					right: afterDirection === Direction.RTL ? charAfter.right : charAfter.left,
					top: after.top,
					bottom: after.bottom,
				}
			: after;

	if (previousBoundary && nextBoundary && sameLineFragment(previousBoundary, nextBoundary)) {
		const x = (previousBoundary.left + nextBoundary.left) / 2;
		return {
			left: x,
			right: x,
			top: Math.min(previousBoundary.top, nextBoundary.top),
			bottom: Math.max(previousBoundary.bottom, nextBoundary.bottom),
		};
	}

	if (nextBoundary) {
		return nextBoundary;
	}

	if (previousBoundary) {
		return previousBoundary;
	}

	const fallback = charAfter ?? charBefore;
	if (!fallback) {
		return null;
	}
	const direction = charAfter !== null ? afterDirection : beforeDirection;
	const x =
		direction === Direction.RTL
			? charAfter !== null
				? fallback.right
				: fallback.left
			: charAfter !== null
				? fallback.left
				: fallback.right;
	return {
		left: x,
		right: x,
		top: fallback.top,
		bottom: fallback.bottom,
	};
}

function buildCaretMarkers(
	view: EditorView,
	app: App,
	localClientId: string,
	rows: readonly PresenceRow[],
): readonly LayerMarker[] {
	const visibleRows = getVisibleRows(view, app, localClientId, rows);
	if (visibleRows.length === 0) {
		return [];
	}

	const base = getLayerBase(view);
	const markers: LayerMarker[] = [];
	for (const row of visibleRows) {
		const caretPos = clampDocPosition(view.state.doc, row.cursor.head);
		const rect = measureCaretRect(view, caretPos);
		if (!rect) {
			continue;
		}

		markers.push(
			new RemoteCaretMarker(
				shortClientId(row.clientId),
				colorsForClient(row.clientId),
				rect.left - base.left,
				rect.top - base.top,
				Math.max(1, rect.bottom - rect.top),
			),
		);
	}

	return markers;
}

function hasPresenceRowsEffect(update: ViewUpdate): boolean {
	for (const tr of update.transactions) {
		for (const effect of tr.effects) {
			if (effect.is(setPresenceRowsEffect)) {
				return true;
			}
		}
	}
	return false;
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
				this.decorations = buildSelectionDecorations(view, app, localClientId, this.rows);
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
					this.decorations = buildSelectionDecorations(
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

	const remoteCaretLayer = layer({
		above: true,
		class: "convex-sync-remote-carets-layer",
		update(update) {
			return (
				hasPresenceRowsEffect(update) ||
				update.docChanged ||
				update.selectionSet ||
				update.viewportChanged ||
				update.focusChanged
			);
		},
		markers(view) {
			return buildCaretMarkers(view, app, localClientId, latestRows);
		},
	});

	const dispatchRows = (): void => {
		for (const view of editorViews) {
			view.dispatch({ effects: setPresenceRowsEffect.of(latestRows) });
		}
	};

	return {
		extension: [extension, remoteCaretLayer],
		setRows(rows) {
			latestRows = rows;
			dispatchRows();
		},
		refresh() {
			dispatchRows();
		},
	};
}
