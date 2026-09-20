import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.hourly(
  "expired provider receipt metadata",
  { minuteUTC: 17 },
  internal.integrations.purgeExpired,
  { kind: "provider" },
);
crons.hourly(
  "expired email receipt metadata",
  { minuteUTC: 23 },
  internal.integrations.purgeExpired,
  { kind: "email" },
);
crons.hourly(
  "expired execution content",
  { minuteUTC: 31 },
  internal.execution.retentionSweep,
  {},
);
export default crons;
