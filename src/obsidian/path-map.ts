import { generateAutomergeUrl, parseAutomergeUrl } from "@automerge/automerge-repo";
import { LocalMetaStore } from "../storage/local-meta-store";

export class PathConflictError extends Error {
	constructor(
		readonly oldPath: string,
		readonly newPath: string,
		readonly existingDocId: string,
	) {
		super(`Cannot rename ${oldPath} to ${newPath}; target path is already mapped`);
		this.name = "PathConflictError";
	}
}

export class PathMap {
	private readonly pendingCreates = new Map<string, Promise<string>>();

	constructor(
		private readonly metaStore: LocalMetaStore,
		private readonly createDocId: () => string = createAutomergeDocumentId,
	) {}

	async getOrCreate(path: string, preferredDocId?: string): Promise<string> {
		const existing = await this.metaStore.getDocIdForPath(path);
		if (existing) {
			return existing;
		}

		const pending = this.pendingCreates.get(path);
		if (pending) {
			return pending;
		}

		const created = this.createMapping(path, preferredDocId);
		this.pendingCreates.set(path, created);
		try {
			return await created;
		} finally {
			this.pendingCreates.delete(path);
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const docId = await this.metaStore.getDocIdForPath(oldPath);
		if (!docId) {
			throw new Error(`Cannot rename unmapped path ${oldPath}`);
		}

		const existingTargetDocId = await this.metaStore.getDocIdForPath(newPath);
		if (existingTargetDocId && existingTargetDocId !== docId) {
			logInfo("conflict on rename", {
				oldPath,
				newPath,
				oldDocId: docId,
				existingDocId: existingTargetDocId,
			});
			throw new PathConflictError(oldPath, newPath, existingTargetDocId);
		}

		await this.metaStore.updatePathForDoc(docId, newPath);
		logInfo("rename", { oldPath, newPath, docId });
	}

	async updatePathForDoc(docId: string, newPath: string): Promise<void> {
		await this.metaStore.updatePathForDoc(docId, newPath);
		logInfo("rename", { newPath, docId });
	}

	async getDocId(path: string): Promise<string | null> {
		return this.metaStore.getDocIdForPath(path);
	}

	async getPathForDocId(docId: string): Promise<string | null> {
		const mappings = await this.getAllMappings();
		for (const [path, mappedDocId] of Object.entries(mappings)) {
			if (mappedDocId === docId) {
				return path;
			}
		}
		return null;
	}

	async remove(path: string): Promise<string | null> {
		const docId = await this.metaStore.getDocIdForPath(path);
		if (!docId) {
			return null;
		}
		await this.metaStore.removePathForDoc(docId);
		return docId;
	}

	async getAllMappings(): Promise<Record<string, string>> {
		return { ...(await this.metaStore.getPathMappings()) };
	}

	private async createMapping(path: string, preferredDocId?: string): Promise<string> {
		const existing = await this.metaStore.getDocIdForPath(path);
		if (existing) {
			return existing;
		}

		const docId = preferredDocId ?? this.createDocId();
		await this.metaStore.setDocIdForPath(path, docId);
		logInfo("created mapping", { path, docId });
		return docId;
	}
}

export function createAutomergeDocumentId(): string {
	return parseAutomergeUrl(generateAutomergeUrl()).documentId;
}

function logInfo(message: string, data: Record<string, unknown>): void {
	console.info(`[pathmap] ${message}`, data);
}
