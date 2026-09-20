import { defineSchema } from "convex/server";
import { coreTables, knowledgeTables } from "./knowledgeSchema";
import { executionTables } from "./executionSchema";
import { platformTables } from "./platformSchema";
import { integrationTables } from "./integrationSchema";

export default defineSchema({
  ...coreTables,
  ...knowledgeTables,
  ...executionTables,
  ...platformTables,
  ...integrationTables,
});
