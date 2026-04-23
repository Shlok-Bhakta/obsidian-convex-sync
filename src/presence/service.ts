import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ConvexHttpClient, type ConvexClient } from "convex/browser";
import {
	App,
	Notice,
	Editor,
	EventRef,
	MarkdownView,
	Platform,
	editorInfoField,
} from "obsidian";
import { api } from "../../convex/_generated/api";
import type { MyPluginSettings } from "../settings";
import { createPresenceDecorations } from "./editor-decorations";
import type { PresenceRow } from "./types";

const HEARTBEAT_MS = 10_000;
const CURSOR_DEBOUNCE_MS = 200;
const EMPTY_CURSOR = {
	anchor: { line: 0, ch: 0 },
	head: { line: 0, ch: 0 },
	from: { line: 0, ch: 0 },
	to: { line: 0, ch: 0 },
};

export type ClientsPresenceHost = {
	app: App;
	settings: MyPluginSettings;
	getPresenceSessionId(): string;
	getConvexRealtimeClient(): ConvexClient | null;
	getKeepaliveHttpClient(): ConvexHttpClient;
	registerEvent(event: EventRef): void;
	registerInterval(id: number): void;
	registerEditorExtension(extension: Extension): void;
	registerDomEvent<K extends keyof WindowEventMap>(
		el: Window,
		type: K,
		callback: (this: HTMLElement, ev: WindowEventMap[K]) => unknown,
		options?: boolean | AddEventListenerOptions,
	): void;
};

type ClientsListUnsubscribe = {
	(): void;
	unsubscribe(): void;
	getCurrentValue(): PresenceRow[] | undefined;
};

function readCursorFromEditor(editor: Editor) {
	return {
		anchor: editor.getCursor("anchor"),
		head: editor.getCursor("head"),
		from: editor.getCursor("from"),
		to: editor.getCursor("to"),
	};
}

function getOpenMarkdownContext(
	app: App,
): { editor: Editor; path: string } | null {
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (!view || !view.editor || !view.file) {
		return null;
	}
	return { editor: view.editor, path: view.file.path };
}

export function leaveClientsPresence(host: ClientsPresenceHost): void {
	const secret = host.settings.convexSecret.trim();
	const clientId = host.getPresenceSessionId().trim();
	if (!secret || !clientId) {
		return;
	}
	try {
		const client = host.getKeepaliveHttpClient();
		void client.mutation(
			api.clients.leave,
			{ convexSecret: secret, clientId },
			{ skipQueue: true },
		);
	} catch (err) {
		console.error("Convex presence leave failed", err);
	}
}

export function startClientsPresence(host: ClientsPresenceHost): () => void {
	const teardowns: Array<() => void> = [];
	const decorations = createPresenceDecorations(
		host.app,
		host.getPresenceSessionId(),
	);
	host.registerEditorExtension(decorations.extension);

	const canRun = (): boolean =>
		host.settings.convexUrl.trim() !== "" &&
		host.settings.convexSecret.trim() !== "" &&
		host.getPresenceSessionId().trim() !== "";

	const pushPresence = (): void => {
		if (!canRun()) {
			return;
		}
		const client = host.getConvexRealtimeClient();
		if (!client) {
			return;
		}
		const ctx = getOpenMarkdownContext(host.app);
		void client
			.mutation(api.clients.updateEditorPresence, {
				convexSecret: host.settings.convexSecret,
				clientId: host.getPresenceSessionId(),
				openFilePath: ctx?.path ?? "",
				cursor: ctx ? readCursorFromEditor(ctx.editor) : EMPTY_CURSOR,
			})
			.catch(() => {});
	};

	const client = host.getConvexRealtimeClient();
	if (canRun() && client) {
		const listUnsub = client.onUpdate(
			api.clients.listActive,
			{ convexSecret: host.settings.convexSecret },
			(rows) => {
				decorations.setRows(rows as PresenceRow[]);
			},
			(err) => {
				new Notice(`Convex presence subscription failed: ${err.message}`, 8000);
				console.error(err);
			},
		) as ClientsListUnsubscribe;
		teardowns.push(() => listUnsub());
		const initialRows = listUnsub.getCurrentValue();
		if (initialRows) {
			decorations.setRows(initialRows);
		}
	}

	const sendHeartbeat = (): void => {
		if (!canRun()) {
			return;
		}
		const client = host.getConvexRealtimeClient();
		if (!client) {
			return;
		}
		void client
			.mutation(api.clients.heartbeat, {
				convexSecret: host.settings.convexSecret,
				clientId: host.getPresenceSessionId(),
			})
			.catch((err) => {
				console.error("Convex presence heartbeat failed", err);
			});
	};

	sendHeartbeat();
	pushPresence();
	const interval = window.setInterval(sendHeartbeat, HEARTBEAT_MS);
	host.registerInterval(interval);
	teardowns.push(() => window.clearInterval(interval));

	let cursorTimer: number | null = null;
	const scheduleCursorPush = (): void => {
		if (cursorTimer !== null) {
			window.clearTimeout(cursorTimer);
		}
		cursorTimer = window.setTimeout(() => {
			cursorTimer = null;
			pushPresence();
		}, CURSOR_DEBOUNCE_MS);
	};
	teardowns.push(() => {
		if (cursorTimer !== null) {
			window.clearTimeout(cursorTimer);
		}
	});

	host.registerEditorExtension(
		EditorView.updateListener.of((update) => {
			if (!update.selectionSet && !update.docChanged) {
				return;
			}
			const info = update.state.field(editorInfoField, false);
			if (!info?.editor) {
				return;
			}
			const active = host.app.workspace.getActiveViewOfType(MarkdownView);
			if (!active || active.editor !== info.editor) {
				return;
			}
			scheduleCursorPush();
		}),
	);

	host.registerEvent(
		host.app.workspace.on("active-leaf-change", () => {
			pushPresence();
			decorations.refresh();
		}),
	);
	host.registerEvent(
		host.app.workspace.on("file-open", () => {
			pushPresence();
			decorations.refresh();
		}),
	);
	host.registerEvent(host.app.workspace.on("quit", () => leaveClientsPresence(host)));

	if (Platform.isDesktopApp) {
		host.registerDomEvent(window, "beforeunload", () => {
			leaveClientsPresence(host);
		});
	}

	return () => teardowns.forEach((t) => t());
}
