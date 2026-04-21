import { ConvexClient, ConvexHttpClient } from "convex/browser";
import type { MyPluginSettings } from "../settings";

export class ConvexClientManager {
	private convexHttpClientCache: { client: ConvexHttpClient; url: string } | null =
		null;
	private convexRealtimeClientCache: {
		client: ConvexClient;
		url: string;
	} | null = null;

	constructor(private readonly readSettings: () => MyPluginSettings) {}

	isConfigured(): boolean {
		const settings = this.readSettings();
		return (
			settings.convexUrl.trim().length > 0 &&
			settings.convexSecret.trim().length > 0
		);
	}

	getHttp(): ConvexHttpClient {
		const settings = this.readSettings();
		const url = settings.convexUrl.trim();
		if (!url) {
			throw new Error(
				"Convex URL is empty. Open plugin settings and set Convex URL (deployment URL).",
			);
		}
		if (!this.convexHttpClientCache || this.convexHttpClientCache.url !== url) {
			this.convexHttpClientCache = { client: new ConvexHttpClient(url), url };
		}
		return this.convexHttpClientCache.client;
	}

	getRealtime(): ConvexClient | null {
		const settings = this.readSettings();
		const url = settings.convexUrl.trim();
		if (!this.isConfigured()) {
			void this.convexRealtimeClientCache?.client.close();
			this.convexRealtimeClientCache = null;
			return null;
		}
		if (!this.convexRealtimeClientCache || this.convexRealtimeClientCache.url !== url) {
			void this.convexRealtimeClientCache?.client.close();
			this.convexRealtimeClientCache = { client: new ConvexClient(url), url };
		}
		return this.convexRealtimeClientCache.client;
	}

	getKeepaliveHttp(): ConvexHttpClient {
		const settings = this.readSettings();
		const url = settings.convexUrl.trim();
		return new ConvexHttpClient(url, {
			fetch: (input, init) =>
				globalThis.fetch(input, {
					...init,
					keepalive: true,
				}),
		});
	}

	dispose(): void {
		void this.convexRealtimeClientCache?.client.close();
		this.convexRealtimeClientCache = null;
		this.convexHttpClientCache = null;
	}
}
