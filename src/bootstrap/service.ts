import type { ConvexHttpClient } from "convex/browser";
import { zipSync } from "fflate";
import { TFile } from "obsidian";
import type { MyPluginSettings } from "../settings";
import { resolveClientId } from "../sync/client-id";

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

type LocalArchive = {
	bytes: Uint8Array;
	filesTotal: number;
	bytesTotal: number;
};

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return toHex(digest);
}

async function collectConfigEntries(
	app: import("obsidian").App,
	configDir: string,
): Promise<Array<{ path: string; bytes: Uint8Array }>> {
	if (!(await app.vault.adapter.exists(configDir))) {
		return [];
	}
	const results: Array<{ path: string; bytes: Uint8Array }> = [];
	const queue: string[] = [configDir];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}
		const listed = await app.vault.adapter.list(current);
		for (const filePath of listed.files) {
			const bytes = new Uint8Array(await app.vault.adapter.readBinary(filePath));
			results.push({ path: filePath, bytes });
		}
		for (const folderPath of listed.folders) {
			queue.push(folderPath);
		}
	}
	return results;
}

async function buildLocalArchive(
	host: BootstrapHost,
	onState: (state: BootstrapUiState) => void,
): Promise<LocalArchive> {
	const archiveEntries: Record<string, Uint8Array> = {};
	const loadedFiles = host.app.vault
		.getAllLoadedFiles()
		.filter((entry): entry is TFile => entry instanceof TFile);
	const configDir = host.app.vault.configDir;
	const configFiles = await collectConfigEntries(host.app, configDir);
	const totalFiles = loadedFiles.length + configFiles.length;
	let completed = 0;
	let bytesTotal = 0;
	for (const file of loadedFiles) {
		const bytes = new Uint8Array(await host.app.vault.readBinary(file));
		archiveEntries[file.path] = bytes;
		completed += 1;
		bytesTotal += bytes.byteLength;
		onState({
			kind: "syncing",
			phase: `Packing local vault (${completed}/${Math.max(totalFiles, 1)})`,
			completed,
			total: Math.max(totalFiles, 1),
		});
	}
	for (const file of configFiles) {
		archiveEntries[file.path] = file.bytes;
		completed += 1;
		bytesTotal += file.bytes.byteLength;
		onState({
			kind: "syncing",
			phase: `Packing local vault (${completed}/${Math.max(totalFiles, 1)})`,
			completed,
			total: Math.max(totalFiles, 1),
		});
	}
	const zipped = zipSync(archiveEntries, { level: 6 });
	return {
		bytes: zipped,
		filesTotal: totalFiles,
		bytesTotal,
	};
}

export async function startBootstrapBuild(
	host: BootstrapHost,
	onState: (state: BootstrapUiState) => void,
): Promise<void> {
	const client = host.getConvexHttpClient();
	onState({ kind: "syncing", phase: "Preparing local vault archive", completed: 0, total: 1 });
	const archive = await buildLocalArchive(host, onState);
	onState({ kind: "syncing", phase: "Requesting upload URL", completed: 1, total: 3 });
	const started = await (client.mutation as any)("bootstrap:startBuild", {
		convexSecret: host.settings.convexSecret,
		clientId: resolveClientId(host),
		vaultName: host.app.vault.getName(),
	});
	onState({ kind: "syncing", phase: "Uploading archive", completed: 2, total: 3 });
	const uploadResponse = await fetch(started.uploadUrl, {
		method: "POST",
		headers: { "Content-Type": "application/zip" },
		body: new Blob([archive.bytes], { type: "application/zip" }),
	});
	if (!uploadResponse.ok) {
		await (client.mutation as any)("bootstrap:failUpload", {
			convexSecret: host.settings.convexSecret,
			bootstrapId: started.bootstrapId,
			message: `Archive upload failed with HTTP ${uploadResponse.status}`,
		});
		throw new Error(`Bootstrap upload failed: HTTP ${uploadResponse.status}`);
	}
	const payload = (await uploadResponse.json()) as { storageId?: string };
	if (!payload.storageId) {
		await (client.mutation as any)("bootstrap:failUpload", {
			convexSecret: host.settings.convexSecret,
			bootstrapId: started.bootstrapId,
			message: "Archive upload did not return a storageId.",
		});
		throw new Error("Bootstrap upload did not return a storageId.");
	}
	const contentHash = await sha256Bytes(archive.bytes);
	onState({ kind: "syncing", phase: "Finalizing archive", completed: 3, total: 3 });
	await (client.mutation as any)("bootstrap:finalizeUploadedArchive", {
		convexSecret: host.settings.convexSecret,
		bootstrapId: started.bootstrapId,
		storageId: payload.storageId,
		contentHash,
		sizeBytes: archive.bytes.byteLength,
		filesTotal: archive.filesTotal,
		bytesTotal: archive.bytesTotal,
	});
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
