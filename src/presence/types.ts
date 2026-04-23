export type EditorCursor = {
	anchor: { line: number; ch: number };
	head: { line: number; ch: number };
	from: { line: number; ch: number };
	to: { line: number; ch: number };
};

export type PresenceRow = {
	clientId: string;
	openFilePath: string;
	cursor: EditorCursor;
	lastHeartbeatAt: number;
};
