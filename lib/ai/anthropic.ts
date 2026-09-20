import type { GenerateInput, GenerateResult, ModelProvider } from "./types";
import { inputTokenBound, reserveCostMicros, SYSTEM_PROMPT } from "./routing";
import { boundedJson, safeProviderId } from "./http";

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async generate(input: GenerateInput): Promise<GenerateResult> {
    try {
      if (!this.apiKey || input.model.provider !== this.id) throw new Error();
      if (
        reserveCostMicros(input.model, input.prompt, input.maxOutputTokens) >
        input.maxCostMicros
      )
        throw new Error();
    } catch {
      return {
        status: "failed",
        errorCode: "configuration_or_budget",
        detail: "The model configuration or cost reservation is not valid.",
      };
    }
    let response: Response;
    try {
      response = await this.fetcher("https://api.anthropic.com/v1/messages", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model.id,
          max_tokens: input.maxOutputTokens,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: input.prompt }],
          stream: false,
        }),
      });
    } catch {
      return {
        status: "uncertain",
        errorCode: "transport_unknown",
        detail:
          "The provider outcome is unknown. The request will not be sent again automatically.",
      };
    }
    if (!response.ok) {
      const knownReject = [400, 401, 403, 404, 413, 422, 429].includes(
        response.status,
      );
      try {
        await response.body?.cancel();
      } catch {
        /* Error bodies are never read or retained. */
      }
      return {
        status: knownReject ? "failed" : "uncertain",
        errorCode: `http_${response.status}`,
        detail: knownReject
          ? "The provider rejected this request. Check model configuration and access."
          : "The provider outcome is unknown. Review it before any new attempt.",
      };
    }
    try {
      const body = (await boundedJson(response)) as {
        model?: string;
        content?: { type?: string; text?: string }[];
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
        stop_reason?: string;
      };
      const usage = body.usage;
      if (
        body.model !== input.model.id ||
        !Array.isArray(body.content) ||
        !usage ||
        !Number.isSafeInteger(usage.input_tokens) ||
        !Number.isSafeInteger(usage.output_tokens) ||
        usage.input_tokens! < 0 ||
        usage.output_tokens! < 0 ||
        usage.output_tokens! > input.maxOutputTokens ||
        usage.input_tokens! > inputTokenBound(input.prompt) ||
        (usage.cache_creation_input_tokens || 0) !== 0 ||
        (usage.cache_read_input_tokens || 0) !== 0 ||
        !["end_turn", "max_tokens", "stop_sequence"].includes(
          body.stop_reason || "",
        )
      )
        throw new Error();
      if (
        body.content.some(
          (block) => block.type === "text" && typeof block.text !== "string",
        )
      )
        throw new Error();
      const text = body.content
        .filter((block) => block.type === "text")
        .map((block) => block.text || "")
        .join("");
      if (
        !text ||
        new TextEncoder().encode(text).byteLength > 100_000 ||
        body.content.some(
          (block) =>
            block.type !== "text" &&
            block.type !== "thinking" &&
            block.type !== "redacted_thinking",
        )
      )
        throw new Error();
      const costMicros =
        usage.input_tokens! * input.model.inputMicrosPerToken +
        usage.output_tokens! * input.model.outputMicrosPerToken;
      if (costMicros > input.maxCostMicros) throw new Error();
      const providerRequestId = safeProviderId(
        response.headers.get("request-id"),
      );
      return {
        status: "succeeded",
        text,
        provider: this.id,
        model: input.model.id,
        inputTokens: usage.input_tokens!,
        outputTokens: usage.output_tokens!,
        costMicros,
        ...(providerRequestId ? { providerRequestId } : {}),
      };
    } catch {
      return {
        status: "uncertain",
        errorCode: "invalid_provider_result",
        detail:
          "The provider response could not be verified. Usage remains reserved for review.",
      };
    }
  }
}
