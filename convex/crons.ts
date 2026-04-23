import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
	"Remove stale Obsidian client presence",
	{ minutes: 1 },
	internal.clients.removeStalePresence,
	{},
);

crons.interval(
	"Remove expired synced trash",
	{ hours: 6 },
	internal.fileSync.cleanupExpiredTrash,
	{},
);

export default crons;
