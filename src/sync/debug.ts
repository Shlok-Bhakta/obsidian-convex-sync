import type { App } from "obsidian";
import type { MyPluginSettings } from "../settings";

export type SyncDebugEvent = {
	time: string;
	area: string;
	message: string;
	data?: Record<string, unknown>;
};

const MAX_EVENTS = 500;

const events: SyncDebugEvent[] = [];

function formatData(data: Record<string, unknown> | undefined): string {
	if (!data) {
		return "";
	}
	try {
		return ` ${JSON.stringify(data)}`;
	} catch (_error) {
		return " [unserializable data]";
	}
}

export function recordSyncDebugEvent(
	settings: Pick<MyPluginSettings, "enableDebugLogging">,
	area: string,
	message: string,
	data?: Record<string, unknown>,
): void {
	if (!settings.enableDebugLogging) {
		return;
	}
	const event = {
		time: new Date().toISOString(),
		area,
		message,
		data,
	};
	events.push(event);
	if (events.length > MAX_EVENTS) {
		events.splice(0, events.length - MAX_EVENTS);
	}
	console.info(`[Convex sync debug] ${area}: ${message}`, data ?? "");
}

export function clearSyncDebugEvents(): void {
	events.length = 0;
}

export function getSyncDebugReport(app: App, settings: MyPluginSettings): string {
	const lines = [
		"Convex sync debug report",
		`Generated: ${new Date().toISOString()}`,
		`Vault: ${app.vault.getName()}`,
		`Convex URL: ${settings.convexUrl || "(empty)"}`,
		`Convex site URL: ${settings.convexSiteUrl || "(empty)"}`,
		`Has secret: ${settings.convexSecret.trim() ? "yes" : "no"}`,
		`Live sync enabled: ${settings.enableLiveSync ? "yes" : "no"}`,
		`Sync .obsidian: ${settings.syncDotObsidian ? "yes" : "no"}`,
		`Debug logging enabled: ${settings.enableDebugLogging ? "yes" : "no"}`,
		`Buffered events: ${events.length}`,
		"",
		"Events:",
	];
	for (const event of events) {
		lines.push(`[${event.time}] ${event.area}: ${event.message}${formatData(event.data)}`);
	}
	return lines.join("\n");
}
