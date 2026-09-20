import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

// One stable component-wide concurrency setting; side effects opt out of retries.
export const workflow = new WorkflowManager(components.workflow, {
  workpoolOptions: {
    maxParallelism: 4,
    retryActionsByDefault: false,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 },
  },
});
export const TASK_TIMEOUT_MS = 60 * 60 * 1000;
export const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_OUTPUT_TOKENS = 4096;
export const MAX_TASK_MICROS = 250_000;
export const DEFAULT_MODELS = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-haiku-4-5-20251001",
];
export const DEFAULT_POLICY = {
  allowedModelIds: DEFAULT_MODELS,
  monthlyWorkspaceMicros: 100_000_000,
  monthlyUserMicros: 20_000_000,
  allowEmail: false,
};
export function billingPeriod(now: number) {
  return new Date(now).toISOString().slice(0, 7);
}
export function safeMicros(value: number) {
  return (
    Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000
  );
}
export function canReserve(
  spent: number,
  reserved: number,
  amount: number,
  limit: number,
) {
  return (
    [spent, reserved, amount, limit].every(safeMicros) &&
    amount > 0 &&
    spent + reserved + amount <= limit
  );
}
export function validRecipient(value: string) {
  return (
    value.length <= 254 &&
    /^[^\s@<>;,\r\n]+@[^\s@<>;,\r\n]+\.[^\s@<>;,\r\n]+$/.test(value)
  );
}
export type ModelDispatch = {
  workspaceId: Id<"workspaces">;
  ownerId: Id<"users">;
  prompt: string;
  model: string;
  maxOutputTokens: number;
  maxCostMicros: number;
  idempotencyKey: string;
  allowedModelIds: string[];
  allowedProviders: string[];
};
export type ModelResult =
  | {
      status: "succeeded";
      text: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costMicros: number;
      providerRequestId?: string;
      contextInvalidated?: boolean;
      contextRefs?: Array<{ entityId: Id<"entities">; revision: number }>;
    }
  | { status: "failed" | "uncertain"; detail: string };
export type ExternalDispatch = {
  workspaceId: Id<"workspaces">;
  ownerId: Id<"users">;
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
};
export type ExternalResult = {
  status: "submitted" | "uncertain" | "failed";
  providerId?: string;
  detail?: string;
};
