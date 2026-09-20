/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as agents from "../agents.js";
import type * as ai from "../ai.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as execution from "../execution.js";
import type * as executionSchema from "../executionSchema.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as integrationSchema from "../integrationSchema.js";
import type * as integrations from "../integrations.js";
import type * as knowledge from "../knowledge.js";
import type * as knowledgeSchema from "../knowledgeSchema.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_conversations from "../lib/conversations.js";
import type * as lib_knowledgeAccess from "../lib/knowledgeAccess.js";
import type * as lib_knowledgeRetention from "../lib/knowledgeRetention.js";
import type * as lib_provisioning from "../lib/provisioning.js";
import type * as lib_workflow from "../lib/workflow.js";
import type * as personalContext from "../personalContext.js";
import type * as platformSchema from "../platformSchema.js";
import type * as provisioning from "../provisioning.js";
import type * as workspaces from "../workspaces.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  agents: typeof agents;
  ai: typeof ai;
  conversations: typeof conversations;
  crons: typeof crons;
  execution: typeof execution;
  executionSchema: typeof executionSchema;
  files: typeof files;
  http: typeof http;
  integrationSchema: typeof integrationSchema;
  integrations: typeof integrations;
  knowledge: typeof knowledge;
  knowledgeSchema: typeof knowledgeSchema;
  "lib/auth": typeof lib_auth;
  "lib/conversations": typeof lib_conversations;
  "lib/knowledgeAccess": typeof lib_knowledgeAccess;
  "lib/knowledgeRetention": typeof lib_knowledgeRetention;
  "lib/provisioning": typeof lib_provisioning;
  "lib/workflow": typeof lib_workflow;
  personalContext: typeof personalContext;
  platformSchema: typeof platformSchema;
  provisioning: typeof provisioning;
  workspaces: typeof workspaces;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
