import { automergeRepoDatabaseName } from "./automerge-repo";
import { localMetaDatabaseName } from "./local-meta-store";

export type ResetLocalSyncStateResult = {
	databaseNames: string[];
};

export async function resetLocalSyncState(
	vaultId: string,
): Promise<ResetLocalSyncStateResult> {
	const metaDatabaseName = localMetaDatabaseName(vaultId);
	const repoDatabaseName = automergeRepoDatabaseName(vaultId);
	const databaseNames = [metaDatabaseName, repoDatabaseName];

	await deleteDatabase(metaDatabaseName);
	await clearObjectStore(repoDatabaseName, "documents");

	return { databaseNames };
}

function deleteDatabase(databaseName: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.deleteDatabase(databaseName);
		request.onsuccess = () => resolve();
		request.onerror = () =>
			reject(request.error ?? new Error(`Failed to delete ${databaseName}`));
		request.onblocked = () =>
			reject(
				new Error(
					`Could not delete ${databaseName} because another sync session is still using it. Reload Obsidian and try again.`,
				),
			);
	});
}

function clearObjectStore(
	databaseName: string,
	storeName: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(databaseName, 1);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(storeName)) {
				db.createObjectStore(storeName);
			}
		};
		request.onerror = () =>
			reject(request.error ?? new Error(`Failed to open ${databaseName}`));
		request.onsuccess = () => {
			const db = request.result;
			const transaction = db.transaction(storeName, "readwrite");
			const store = transaction.objectStore(storeName);
			store.clear();
			transaction.oncomplete = () => {
				db.close();
				resolve();
			};
			transaction.onerror = () => {
				db.close();
				reject(transaction.error ?? new Error(`Failed to clear ${databaseName}`));
			};
			transaction.onabort = () => {
				db.close();
				reject(transaction.error ?? new Error(`Clear aborted for ${databaseName}`));
			};
		};
	});
}
