export type Capability = "text" | "vision" | "tools";
export type QualityTier = "fast" | "balanced" | "high";
export type LatencyTier = "low" | "medium" | "high";
export interface ModelDescriptor {
  id: string;
  provider: string;
  label: string;
  capabilities: readonly Capability[];
  contextTokens: number;
  maxOutputTokens: number;
  quality: QualityTier;
  latency: LatencyTier;
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
}
export interface RoutingPolicy {
  allowedProviders: readonly string[];
  allowedModelIds: readonly string[];
  requiredCapabilities?: readonly Capability[];
  minimumQuality?: QualityTier;
  maximumLatency?: LatencyTier;
  maxCostMicros: number;
}
export interface GenerateInput {
  prompt: string;
  model: ModelDescriptor;
  maxOutputTokens: number;
  maxCostMicros: number;
}
export type GenerateResult =
  | {
      status: "succeeded";
      text: string;
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      costMicros: number;
      providerRequestId?: string;
    }
  | { status: "failed" | "uncertain"; detail: string; errorCode: string };
export interface ModelProvider {
  readonly id: string;
  generate(input: GenerateInput): Promise<GenerateResult>;
}
