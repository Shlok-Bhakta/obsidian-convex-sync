import type { ConvexHttpClient } from "convex/browser";
import { runVaultFileSync } from "../file-sync";
import { uploadLocalFile } from "../file-sync/remote-transfer";
import type { MyPluginSettings } from "../settings";

type BootstrapHost = {
	app: import("obsidian").App;
	settings: MyPluginSettings;
	getConvexHttpClient(): ConvexHttpClient;
	getPresenceSessionId(): string;
};

export type BootstrapUiState =
	| {
			kind: "idle";
	  }
	| {
			kind: "syncing";
			phase: string;
			completed: number;
			total: number;
	  }
	| {
			kind: "building";
			phase: string;
			filesProcessed: number;
			filesTotal: number;
			bytesProcessed: number;
			bytesTotal: number;
	  }
	| {
			kind: "ready";
			phase: string;
			url: string;
			expiresAtMs: number;
			sizeBytes: number;
	  }
	| {
			kind: "failed";
			phase: string;
			message: string;
	  }
	| {
			kind: "expired";
			phase: string;
	  };

type BootstrapStatus = {
	status: "idle" | "building" | "ready" | "failed" | "expired";
	phase?: string;
	filesProcessed?: number;
	filesTotal?: number;
	bytesProcessed?: number;
	bytesTotal?: number;
	sizeBytes?: number | null;
	expiresAtMs?: number | null;
	errorMessage?: string | null;
	downloadUrl?: string | null;
	archiveName?: string | null;
};

const PLUGIN_RELEASE_ARTIFACTS = [
	".obsidian/plugins/obsidian-convex-sync/main.js",
	".obsidian/plugins/obsidian-convex-sync/manifest.json",
	".obsidian/plugins/obsidian-convex-sync/styles.css",
];

export async function startBootstrapBuild(
	host: BootstrapHost,
	onState: (state: BootstrapUiState) => void,
): Promise<void> {
	const client = host.getConvexHttpClient();
	onState({ kind: "syncing", phase: "Syncing vault to Convex", completed: 0, total: 1 });
	await runVaultFileSync({
		app: host.app,
		settings: host.settings,
		getConvexHttpClient: host.getConvexHttpClient,
		getPresenceSessionId: host.getPresenceSessionId,
		reportSyncProgress: ({ phase, completed, total }) => {
			onState({
				kind: "syncing",
				phase,
				completed,
				total,
			});
		},
	});
	onState({ kind: "syncing", phase: "Pinning plugin artifacts", completed: 1, total: 1 });
	await uploadLocalPluginArtifacts(host);
	await (client.mutation as any)("bootstrap:startBuild", {
		convexSecret: host.settings.convexSecret,
		clientId: host.getPresenceSessionId(),
		vaultName: host.app.vault.getName(),
	});
}

async function uploadLocalPluginArtifacts(host: BootstrapHost): Promise<void> {
	const client = host.getConvexHttpClient();
	const secret = host.settings.convexSecret.trim();
	const clientId = host.getPresenceSessionId();
	for (const path of PLUGIN_RELEASE_ARTIFACTS) {
		const exists = await host.app.vault.adapter.exists(path);
		if (!exists) {
			continue;
		}
		const bytes = await host.app.vault.adapter.readBinary(path);
		await uploadLocalFile(client, secret, clientId, path, bytes, Date.now(), {
			force: true,
		});
	}
}

export async function readBootstrapStatus(
	host: BootstrapHost,
): Promise<BootstrapUiState> {
	const client = host.getConvexHttpClient();
	const status = (await (client.query as any)("bootstrap:getStatus", {
		convexSecret: host.settings.convexSecret,
	})) as BootstrapStatus;
	switch (status.status) {
		case "idle":
			return { kind: "idle" };
		case "building":
			return {
				kind: "building",
				phase: status.phase ?? "Building archive",
				filesProcessed: status.filesProcessed ?? 0,
				filesTotal: status.filesTotal ?? 0,
				bytesProcessed: status.bytesProcessed ?? 0,
				bytesTotal: status.bytesTotal ?? 0,
			};
		case "ready":
			if (status.downloadUrl && status.expiresAtMs && status.expiresAtMs > Date.now()) {
				const base = host.settings.convexSiteUrl.replace(/\/+$/, "");
				return {
					kind: "ready",
					phase: status.phase ?? "Ready",
					url: `${base}${status.downloadUrl}`,
					expiresAtMs: status.expiresAtMs,
					sizeBytes: status.sizeBytes ?? 0,
				};
			}
			return { kind: "expired", phase: "Expired" };
		case "failed":
			return {
				kind: "failed",
				phase: status.phase ?? "Failed",
				message: status.errorMessage ?? "Bootstrap archive build failed.",
			};
		case "expired":
		default:
			return { kind: "expired", phase: status.phase ?? "Expired" };
	}
}

export async function cancelBootstrap(host: BootstrapHost): Promise<void> {
	await (host.getConvexHttpClient().mutation as any)("bootstrap:cancelBootstrap", {
		convexSecret: host.settings.convexSecret,
	});
}
