import { requestUrl } from "obsidian";

function recordFromHeadersInit(headers: HeadersInit | undefined): Record<string, string> | undefined {
	if (headers === undefined) {
		return undefined;
	}
	if (headers instanceof Headers) {
		const out: Record<string, string> = {};
		headers.forEach((value, key) => {
			out[key] = value;
		});
		return out;
	}
	if (Array.isArray(headers)) {
		return Object.fromEntries(headers);
	}
	return headers as Record<string, string>;
}

function resolveUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return input.url;
}

function resolveBody(init?: RequestInit): string | ArrayBuffer | undefined {
	const body = init?.body;
	if (body === undefined || body === null) {
		return undefined;
	}
	if (typeof body === "string") {
		return body;
	}
	if (body instanceof ArrayBuffer) {
		return body;
	}
	if (body instanceof Uint8Array) {
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	}
	if (body instanceof DataView) {
		return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
	}
	throw new Error(
		"[obsidian-convex-sync] Convex HTTP client received an unsupported request body type; use string or ArrayBuffer.",
	);
}

/**
 * Minimal `Response` shape for Convex's HTTP client (status, ok, text(), json()).
 * Backed by Obsidian {@link requestUrl} so Convex calls are not subject to browser CORS.
 */
class ObsidianBackedResponse {
	constructor(private readonly raw: import("obsidian").RequestUrlResponse) {}

	get status(): number {
		return this.raw.status;
	}

	get ok(): boolean {
		return this.raw.status >= 200 && this.raw.status < 300;
	}

	get headers(): Headers {
		const h = new Headers();
		for (const [key, value] of Object.entries(this.raw.headers)) {
			h.set(key, value);
		}
		return h;
	}

	async text(): Promise<string> {
		return this.raw.text;
	}

	async json(): Promise<unknown> {
		return this.raw.json;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return this.raw.arrayBuffer;
	}
}

/**
 * Drop-in `fetch` for {@link ConvexHttpClient} options. Uses Obsidian's `requestUrl`, which
 * is not restricted by the `app://obsidian.md` CORS policy that breaks `globalThis.fetch`
 * against self-hosted or proxied Convex URLs.
 */
export function createObsidianBackedFetch(): typeof fetch {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const url = resolveUrl(input);
		const method = init?.method ?? "GET";
		const headers = recordFromHeadersInit(init?.headers);
		const body = resolveBody(init);
		const res = await requestUrl({
			url,
			method,
			headers,
			body,
			throw: false,
		});
		return new ObsidianBackedResponse(res) as unknown as Response;
	};
}
