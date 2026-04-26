import type { Extension } from "@codemirror/state";
import type { App } from "obsidian";
import { normalizePath } from "obsidian";
import type { ConvexClient } from "convex/browser";
import { Awareness } from "y-protocols/awareness.js";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import type { api } from "../../convex/_generated/api";
import { ConvexAwarenessSync } from "./convex-awareness-sync";
import { ConvexYjsProvider } from "./ConvexYjsProvider";
import { YjsLocalCache } from "./yjs-local-cache";

type DocEntry = {
	doc: Y.Doc;
	awareness: Awareness;
	provider: ConvexYjsProvider;
	awarenessSync: ConvexAwarenessSync | null;
};

export class DocManager {
	// Mutable array - Obsidian watches this reference.
	readonly extensions: Extension[] = [];
	private current: DocEntry | null = null;
	private currentPath: string | null = null;

	/** Current Yjs awareness for the open collaborative doc (sidebar presence merge). */
	getCurrentAwareness(): Awareness | null {
		return this.current?.awareness ?? null;
	}

	constructor(
		private readonly app: App,
		private readonly client: ConvexClient,
		private readonly convexApi: typeof api,
		private readonly clientId: string,
		private readonly convexSecret: string,
	) {}

	async onFileOpen(path: string): Promise<void> {
		if (path === this.currentPath) return;
		await this.closeCurrentDoc();

		const docId = this.pathToDocId(path);
		const doc = new Y.Doc();
		const awareness = new Awareness(doc);

		// Load cached state first for instant warm start.
		await YjsLocalCache.load(docId, doc);

		const provider = new ConvexYjsProvider(
			this.client,
			docId,
			doc,
			this.convexApi.yjs,
		);
		await provider.init();

		awareness.setLocalStateField("user", {
			name: this.clientId.slice(0, 8),
			color: hashColor(this.clientId),
		});
		awareness.setLocalStateField("openFilePath", path);

		const persistDocAndManifest = debounce(async () => {
			await YjsLocalCache.save(docId, doc);
			const content = doc.getText("content").toString();
			const hash = await sha256Utf8(content);
			await this.client.mutation(this.convexApi.fileSync.registerTextFile, {
				convexSecret: this.convexSecret,
				path: normalizePath(path),
				contentHash: hash,
				sizeBytes: new TextEncoder().encode(content).length,
				updatedAtMs: Date.now(),
				clientId: this.clientId,
			});
		}, 500);

		doc.on("update", () => {
			persistDocAndManifest();
		});

		const awarenessSync =
			this.convexSecret.trim() !== ""
				? new ConvexAwarenessSync(
						this.client,
						docId,
						awareness,
						this.convexApi.yjsAwareness,
						this.convexSecret,
					)
				: null;

		this.current = { doc, awareness, provider, awarenessSync };
		this.currentPath = path;

		const ytext = doc.getText("content");
		this.extensions.length = 0;
		this.extensions.push(yCollab(ytext, awareness));
		this.app.workspace.updateOptions();
	}

	async closeCurrentDoc(): Promise<void> {
		if (!this.current) return;
		const { doc, awareness, provider, awarenessSync } = this.current;
		if (this.currentPath) {
			await YjsLocalCache.save(this.pathToDocId(this.currentPath), doc);
		}
		if (awarenessSync) {
			awarenessSync.flush();
			awareness.setLocalState(null);
			awarenessSync.flush();
			awarenessSync.destroy();
		}
		provider.destroy();
		awareness.destroy();
		doc.destroy();
		this.extensions.length = 0;
		this.app.workspace.updateOptions();
		this.current = null;
		this.currentPath = null;
	}

	async dispose(): Promise<void> {
		await this.closeCurrentDoc();
	}

	private pathToDocId(path: string): string {
		return `${this.app.vault.getName()}::${path}`;
	}
}

function hashColor(id: string): string {
	let hash = 0;
	for (const c of id) hash = (Math.imul(31, hash) + c.charCodeAt(0)) | 0;
	return `hsl(${Math.abs(hash) % 360}, 70%, 45%)`;
}

function debounce(fn: () => Promise<void>, ms: number): () => void {
	let timer: ReturnType<typeof setTimeout>;
	return () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			void fn();
		}, ms);
	};
}

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function sha256Utf8(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return toHex(digest);
}
