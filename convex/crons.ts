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
	"Compact hot live-sync docs",
	{ minutes: 15 },
	internal.sync.compactHotDocs,
	{},
);

crons.cron(
	"Sweep expired trashed docs",
	"0 3 * * *",
	internal.sync.sweepTrash,
	{},
);

export default crons;
