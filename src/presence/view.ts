import { Notice, WorkspaceLeaf, ItemView, App } from "obsidian";
import type { Awareness } from "y-protocols/awareness.js";
import { api } from "../../convex/_generated/api";
import { shortClientId } from "./formatting";
import type { ClientsPresenceHost } from "./service";

export const CLIENTS_PRESENCE_VIEW_TYPE = "obsidian-convex-sync-clients";

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

type ClientsListUnsubscribe = {
	(): void;
	unsubscribe(): void;
	getCurrentValue(): PresenceRow[] | undefined;
};

function openPathFromAwareness(awareness: Awareness, clientId: string): string | undefined {
	const prefix = clientId.slice(0, 8);
	for (const state of awareness.getStates().values()) {
		const userRaw: unknown = state["user"];
		const userName =
			userRaw &&
			typeof userRaw === "object" &&
			"name" in userRaw &&
			typeof (userRaw as { name: unknown }).name === "string"
				? (userRaw as { name: string }).name
				: undefined;
		if (userName !== prefix) continue;
		const pathRaw: unknown = state["openFilePath"];
		if (typeof pathRaw === "string" && pathRaw.length > 0) return pathRaw;
	}
	return undefined;
}

function mergeRows(rows: PresenceRow[], awareness: Awareness | null): PresenceRow[] {
	if (!awareness) return rows;
	return rows.map((row) => {
		const fromAwareness = openPathFromAwareness(awareness, row.clientId);
		if (fromAwareness !== undefined) {
			return { ...row, openFilePath: fromAwareness };
		}
		return row;
	});
}

export class ClientsPresenceView extends ItemView {
	private listUnsub: ClientsListUnsubscribe | null = null;
	private tableBody: HTMLTableSectionElement | null = null;
	private lastRows: PresenceRow[] = [];
	private awarenessUnsub: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, private readonly host: ClientsPresenceHost) {
		super(leaf);
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

	private detachAwarenessListener(): void {
		if (this.awarenessUnsub) {
			this.awarenessUnsub();
			this.awarenessUnsub = null;
		}
	}

	private attachAwarenessListener(): void {
		this.detachAwarenessListener();
		const aw = this.host.getDocAwareness();
		if (!aw) return;
		const onChange = (): void => {
			this.draw(this.lastRows);
		};
		aw.on("change", onChange);
		this.awarenessUnsub = () => {
			aw.off("change", onChange);
		};
	}

	private draw(rows: PresenceRow[]): void {
		this.lastRows = rows;
		if (!this.tableBody) return;
		const merged = mergeRows(rows, this.host.getDocAwareness());
		this.tableBody.empty();
		if (merged.length === 0) {
			this.tableBody.createEl("tr").createEl("td", {
				text: "No active clients (heartbeats within the last 30 seconds).",
				attr: { colSpan: 3 },
			});
			return;
		}
		for (const row of merged) {
			const tr = this.tableBody.createEl("tr");
			tr.createEl("td", { text: shortClientId(row.clientId), title: row.clientId });
			tr.createEl("td", { text: row.openFilePath || "—", cls: "convex-sync-clients-path" });
			const ageSec = Math.max(0, Math.round((Date.now() - row.lastHeartbeatAt) / 1000));
			tr.createEl("td", { text: `${ageSec}s ago` });
		}
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
		hr.createEl("th", { text: "Last heartbeat" });
		this.tableBody = table.createEl("tbody");

		const secret = this.host.settings.convexSecret.trim();
		if (secret === "") {
			this.tableBody.createEl("tr").createEl("td", {
				text: "Set and register your vault API key in plugin settings to see clients.",
				attr: { colSpan: 3 },
			});
			return;
		}
		const client = this.host.getConvexRealtimeClient();
		if (!client) {
			this.tableBody.createEl("tr").createEl("td", {
				text: "Convex URL is not configured.",
				attr: { colSpan: 3 },
			});
			return;
		}

		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				this.attachAwarenessListener();
				this.draw(this.lastRows);
			}),
		);

		this.listUnsub = client.onUpdate(
			api.clients.listActive,
			{ convexSecret: secret },
			(rows) => {
				this.draw(rows);
			},
			(err) => {
				new Notice(`Convex clients list failed: ${err.message}`, 8000);
				console.error(err);
			},
		) as ClientsListUnsubscribe;
		const initial = this.listUnsub.getCurrentValue();
		this.attachAwarenessListener();
		if (initial) this.draw(initial);
		else this.draw([]);
	}

	async onClose(): Promise<void> {
		this.detachAwarenessListener();
		if (this.listUnsub) {
			this.listUnsub();
			this.listUnsub = null;
		}
		this.tableBody = null;
		this.lastRows = [];
		this.contentEl.empty();
	}
}

export async function revealClientsPresenceView(app: App): Promise<void> {
	const { workspace } = app;
	const leaves = workspace.getLeavesOfType(CLIENTS_PRESENCE_VIEW_TYPE);
	let leaf = leaves[0] ?? null;
	if (!leaf) {
		const right = workspace.getRightLeaf(false);
		if (!right) {
			new Notice("Could not open a sidebar for connected clients.", 6000);
			return;
		}
		leaf = right;
		await leaf.setViewState({ type: CLIENTS_PRESENCE_VIEW_TYPE, active: true });
	}
	if (leaf) void workspace.revealLeaf(leaf);
}
