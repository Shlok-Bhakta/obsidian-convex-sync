import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import {
	App,
	Editor,
	EventRef,
	ItemView,
	MarkdownView,
	Notice,
	Platform,
	WorkspaceLeaf,
	editorInfoField,
} from "obsidian";
import { api } from "../convex/_generated/api";
import type { MyPluginSettings } from "./settings";

export const CLIENTS_PRESENCE_VIEW_TYPE = "obsidian-convex-sync-clients";

const HEARTBEAT_MS = 10_000;
const CURSOR_DEBOUNCE_MS = 200;

export type ClientsPresenceHost = {
	app: App;
	settings: MyPluginSettings;
	/** Per-load session id for Convex presence rows (not synced). */
	getPresenceSessionId(): string;
	getConvexRealtimeClient(): ConvexClient | null;
	getConvexHttpClient(): ConvexHttpClient;
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

type PresenceRow = {
	clientId: string;
	openFilePath: string;
	cursor: {
		anchor: { line: number; ch: number };
		head: { line: number; ch: number };
		from: { line: number; ch: number };
		to: { line: number; ch: number };
	};
	lastHeartbeatAt: number;
};

function formatPos(p: { line: number; ch: number }): string {
	return `L${p.line}:${p.ch}`;
}

function formatCursor(c: PresenceRow["cursor"]): string {
	return `a ${formatPos(c.anchor)} · h ${formatPos(c.head)} · ${formatPos(c.from)}→${formatPos(c.to)}`;
}

function shortClientId(id: string): string {
	if (id.length <= 12) {
		return id;
	}
	return `${id.slice(0, 8)}…`;
}

function readCursorFromEditor(editor: Editor): PresenceRow["cursor"] {
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
	if (!view || !view.editor) {
		return null;
	}
	const file = view.file;
	if (!file) {
		return null;
	}
	return { editor: view.editor, path: file.path };
}

/**
 * Registers the clients table view, heartbeat + editor presence sync, and returns teardown.
 */
export function startClientsPresence(host: ClientsPresenceHost): () => void {
	const teardowns: Array<() => void> = [];

	const canRun = (): boolean =>
		host.settings.convexUrl.trim() !== "" &&
		host.settings.convexSecret.trim() !== "" &&
		host.getPresenceSessionId().trim() !== "";

	const pushPresence = (): void => {
		if (!canRun()) {
			return;
		}
		const ctx = getOpenMarkdownContext(host.app);
		const client = host.getConvexRealtimeClient();
		if (!client) {
			return;
		}
		const secret = host.settings.convexSecret;
		const clientId = host.getPresenceSessionId();
		if (!ctx) {
			void client
				.mutation(api.clients.updateEditorPresence, {
					convexSecret: secret,
					clientId,
					openFilePath: "",
					cursor: {
						anchor: { line: 0, ch: 0 },
						head: { line: 0, ch: 0 },
						from: { line: 0, ch: 0 },
						to: { line: 0, ch: 0 },
					},
				})
				.catch(() => {});
			return;
		}
		void client
			.mutation(api.clients.updateEditorPresence, {
				convexSecret: secret,
				clientId,
				openFilePath: ctx.path,
				cursor: readCursorFromEditor(ctx.editor),
			})
			.catch(() => {});
	};

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
			.catch(err => {
				console.error("Convex presence heartbeat failed", err);
			});
	};

	sendHeartbeat();
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

	/**
	 * `workspace.on("editor-change")` mostly tracks document edits. Caret moves and
	 * selection changes without typing are reported via CodeMirror's `selectionSet`.
	 * @see https://docs.obsidian.md/Reference/TypeScript+API/Editor/getCursor
	 */
	host.registerEditorExtension(
		EditorView.updateListener.of(update => {
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
		}),
	);

	host.registerEvent(
		host.app.workspace.on("file-open", () => {
			pushPresence();
		}),
	);

	/**
	 * Normal app exit: Obsidian fires `quit` while the process can still do network I/O.
	 * Plugin `onunload` also calls {@link leaveClientsPresence} (disable/reload/vault unload).
	 * Neither is guaranteed on force-kill; heartbeats + stale GC remain the failsafe.
	 */
	host.registerEvent(
		host.app.workspace.on("quit", () => {
			leaveClientsPresence(host);
		}),
	);

	/**
	 * Desktop window close: `fetch` is otherwise often aborted before the HTTP
	 * round-trip finishes. `keepalive` + `beforeunload` improves odds the leave reaches Convex.
	 */
	if (Platform.isDesktopApp) {
		host.registerDomEvent(window, "beforeunload", () => {
			leaveClientsPresence(host);
		});
	}

	return () => {
		for (const t of teardowns) {
			t();
		}
	};
}

/**
 * Removes this session's presence row. Uses a throwaway HTTP client so the request
 * is not stuck behind {@link ConvexHttpClient}'s default mutation queue, and sets
 * `fetch(..., { keepalive: true })` so the browser is more likely to complete the
 * request during window teardown (quit / beforeunload / plugin unload).
 */
export function leaveClientsPresence(host: ClientsPresenceHost): void {
	const url = host.settings.convexUrl.trim();
	const secret = host.settings.convexSecret.trim();
	const clientId = host.getPresenceSessionId().trim();
	if (!url || !secret || !clientId) {
		return;
	}
	try {
		const client = new ConvexHttpClient(url, {
			fetch: (input, init) =>
				globalThis.fetch(input, {
					...init,
					keepalive: true,
				}),
		});
		void client.mutation(
			api.clients.leave,
			{ convexSecret: secret, clientId },
			{ skipQueue: true },
		);
	} catch (err) {
		console.error("Convex presence leave failed", err);
	}
}

type ClientsListUnsubscribe = {
	(): void;
	unsubscribe(): void;
	getCurrentValue(): PresenceRow[] | undefined;
};

export class ClientsPresenceView extends ItemView {
	private readonly host: ClientsPresenceHost;
	private listUnsub: ClientsListUnsubscribe | null = null;
	private tableBody: HTMLTableSectionElement | null = null;

	constructor(leaf: WorkspaceLeaf, host: ClientsPresenceHost) {
		super(leaf);
		this.host = host;
	}

	getViewType(): string {
		return CLIENTS_PRESENCE_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Connected clients";
	}

	getIcon(): string {
		return "users";
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h4", { text: "Connected clients" });
		const wrap = contentEl.createDiv({ cls: "convex-sync-clients-table-wrap" });
		const table = wrap.createEl("table", { cls: "convex-sync-clients-table" });
		const thead = table.createEl("thead");
		const hr = thead.createEl("tr");
		hr.createEl("th", { text: "Client" });
		hr.createEl("th", { text: "Open file" });
		hr.createEl("th", { text: "Cursor" });
		hr.createEl("th", { text: "Last heartbeat" });
		this.tableBody = table.createEl("tbody");

		const secret = this.host.settings.convexSecret.trim();
		if (secret === "") {
			this.tableBody.createEl("tr").createEl("td", {
				text: "Set and register your vault API key in plugin settings to see clients.",
				attr: { colSpan: 4 },
			});
			return;
		}

		const client = this.host.getConvexRealtimeClient();
		if (!client) {
			this.tableBody.createEl("tr").createEl("td", {
				text: "Convex URL is not configured.",
				attr: { colSpan: 4 },
			});
			return;
		}

		const render = (rows: PresenceRow[]): void => {
			if (!this.tableBody) {
				return;
			}
			this.tableBody.empty();
			if (rows.length === 0) {
				this.tableBody.createEl("tr").createEl("td", {
					text: "No active clients (heartbeats within the last 30 seconds).",
					attr: { colSpan: 4 },
				});
				return;
			}
			for (const row of rows) {
				const tr = this.tableBody.createEl("tr");
				tr.createEl("td", {
					text: shortClientId(row.clientId),
					title: row.clientId,
				});
				tr.createEl("td", {
					text: row.openFilePath || "—",
					cls: "convex-sync-clients-path",
				});
				tr.createEl("td", {
					text: formatCursor(row.cursor),
					cls: "convex-sync-clients-cursor",
				});
				const ageSec = Math.max(
					0,
					Math.round((Date.now() - row.lastHeartbeatAt) / 1000),
				);
				tr.createEl("td", { text: `${ageSec}s ago` });
			}
		};

		this.listUnsub = client.onUpdate(
			api.clients.listActive,
			{ convexSecret: secret },
			render,
			err => {
				new Notice(`Convex clients list failed: ${err.message}`, 8000);
				console.error(err);
			},
		) as ClientsListUnsubscribe;
		const initial = this.listUnsub.getCurrentValue();
		if (initial) {
			render(initial);
		}
	}

	async onClose(): Promise<void> {
		if (this.listUnsub) {
			this.listUnsub();
			this.listUnsub = null;
		}
		this.tableBody = null;
		this.contentEl.empty();
	}
}

export async function revealClientsPresenceView(
	app: App,
): Promise<void> {
	const { workspace } = app;
	const leaves = workspace.getLeavesOfType(CLIENTS_PRESENCE_VIEW_TYPE);
	let leaf = leaves[0] ?? null;
	if (!leaf) {
		const right = workspace.getRightLeaf(false);
		if (!right) {
			new Notice("Could not open a sidebar for Connected clients.", 6000);
			return;
		}
		leaf = right;
		await leaf.setViewState({
			type: CLIENTS_PRESENCE_VIEW_TYPE,
			active: true,
		});
	}
	if (leaf) {
		workspace.revealLeaf(leaf);
	}
}
