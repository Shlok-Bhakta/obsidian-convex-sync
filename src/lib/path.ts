export function folderPathForFile(filePath: string): string | null {
	const slash = filePath.lastIndexOf("/");
	return slash < 0 ? null : filePath.slice(0, slash);
}
