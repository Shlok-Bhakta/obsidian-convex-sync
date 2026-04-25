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
	await deleteDatabase(repoDatabaseName);

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
