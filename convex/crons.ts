import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
	"Remove stale Obsidian client presence",
	{ minutes: 1 },
	internal.clients.removeStalePresence,
	{},
);

export default crons;
