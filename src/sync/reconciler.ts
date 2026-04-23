import { TFile, TFolder } from "obsidian";
import { api } from "../../convex/_generated/api";
import type { ConvexNetworkAdapter, LiveSyncNetworkHost } from "./convex-network-adapter";
import type { LiveSyncRepo } from "./repo";
import {
	isManagedSyncPath,
	kindForAbstractFile,
	randomDocId,
	sha256Bytes,
} from "./shared";

export type RemoteIndexSnapshot = Awaited<
	ReturnType<ReturnType<LiveSyncNetworkHost["getConvexHttpClient"]>["query"]>
>;

export async function loadRemoteIndex(host: LiveSyncNetworkHost) {
	return host.getConvexHttpClient().query(api.sync.subscribeIndex, {
		convexSecret: host.settings.convexSecret,
		since: 0,
	});
}

export async function bootstrapLocalState(
	host: LiveSyncNetworkHost & { app: import("obsidian").App },
	repo: LiveSyncRepo,
	network: ConvexNetworkAdapter,
	remoteDocs: Array<{ docId: string; path: string; kind: "text" | "binary" | "folder"; binaryHead: { updatedAtMs: number } | null }>,
): Promise<void> {
	const remoteByPath = new Map(remoteDocs.map((doc) => [doc.path, doc]));
	for (const entry of host.app.vault.getAllLoadedFiles()) {
		if (!isManagedSyncPath(entry.path, host.settings.syncIgnorePaths)) {
			continue;
		}
		const remote = remoteByPath.get(entry.path);
		if (entry instanceof TFolder) {
			if (!remote) {
				await network.createDoc({
					docId: randomDocId(),
					path: entry.path,
					kind: "folder",
				});
			}
			continue;
		}
		if (!(entry instanceof TFile)) {
			continue;
		}
		const kind = kindForAbstractFile(entry);
		if (kind === "text") {
			const text = await host.app.vault.cachedRead(entry);
			if (remote) {
				const result = await repo.applyLocalText(remote.docId, entry.path, text);
				if (result.changed) {
					network.scheduleFlush(remote.docId, entry.path);
				}
			} else {
				const docId = randomDocId();
				await network.createDoc({ docId, path: entry.path, kind: "text" });
				await repo.applyLocalText(docId, entry.path, text);
				network.scheduleFlush(docId, entry.path);
			}
			continue;
		}
		const remoteUpdatedAtMs = remote?.binaryHead?.updatedAtMs ?? 0;
		if (!remote || entry.stat.mtime > remoteUpdatedAtMs) {
			const docId = remote?.docId ?? randomDocId();
			if (!remote) {
				await network.createDoc({ docId, path: entry.path, kind: "binary" });
			}
			const bytes = await host.app.vault.readBinary(entry);
			const storageId = await network.uploadBytes(bytes, "application/octet-stream");
			await network.putBinaryVersion({
				docId,
				storageId,
				contentHash: await sha256Bytes(bytes),
				sizeBytes: bytes.byteLength,
				updatedAtMs: entry.stat.mtime,
			});
		}
	}
}
