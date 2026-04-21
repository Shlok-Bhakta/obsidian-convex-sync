import { Notice, WorkspaceLeaf, ItemView, App } from "obsidian";
import { api } from "../../convex/_generated/api";
import { formatCursor, shortClientId } from "./formatting";
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

export class ClientsPresenceView extends ItemView {
	private listUnsub: ClientsListUnsubscribe | null = null;
	private tableBody: HTMLTableSectionElement | null = null;

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
			if (!this.tableBody) return;
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
				tr.createEl("td", { text: shortClientId(row.clientId), title: row.clientId });
				tr.createEl("td", { text: row.openFilePath || "—", cls: "convex-sync-clients-path" });
				tr.createEl("td", { text: formatCursor(row.cursor), cls: "convex-sync-clients-cursor" });
				const ageSec = Math.max(0, Math.round((Date.now() - row.lastHeartbeatAt) / 1000));
				tr.createEl("td", { text: `${ageSec}s ago` });
			}
		};

		this.listUnsub = client.onUpdate(
			api.clients.listActive,
			{ convexSecret: secret },
			render,
			(err) => {
				new Notice(`Convex clients list failed: ${err.message}`, 8000);
				console.error(err);
			},
		) as ClientsListUnsubscribe;
		const initial = this.listUnsub.getCurrentValue();
		if (initial) render(initial);
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

export async function revealClientsPresenceView(app: App): Promise<void> {
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
		await leaf.setViewState({ type: CLIENTS_PRESENCE_VIEW_TYPE, active: true });
	}
	if (leaf) workspace.revealLeaf(leaf);
}
