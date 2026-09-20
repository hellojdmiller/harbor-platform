import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../lib/ai/anthropic";
import {
  configuredModels,
  getModel,
  inputTokenBound,
  reserveCostMicros,
  routeModel,
  SYSTEM_PROMPT,
} from "../lib/ai/routing";
import { ResendEmailAdapter } from "../lib/integrations/resend";
import {
  readBoundedWebhook,
  receiptFromPayload,
  verifySvix,
} from "../lib/integrations/webhooks";

const model = getModel("claude-sonnet-5");
const input = {
  prompt: "Draft a fictional project update.",
  model,
  maxOutputTokens: 1024,
  maxCostMicros: 100_000,
};
function response(overrides: Record<string, unknown> = {}) {
  return Response.json(
    {
      model: model.id,
      content: [{ type: "text", text: "Fictional project update." }],
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: "end_turn",
      ...overrides,
    },
    { headers: { "request-id": "req_fixture" } },
  );
}

describe("model policy and bounded accounting", () => {
  const policy = {
    allowedProviders: ["anthropic"],
    allowedModelIds: [model.id],
    maxCostMicros: 100_000,
  };
  it("routes an explicit documented model and reserves conservative plain-text cost", () => {
    const route = routeModel(model.id, input.prompt, 1024, policy);
    expect(route.model.id).toBe(model.id);
    expect(route.reservationMicros).toBe(
      reserveCostMicros(model, input.prompt, 1024),
    );
    expect(route.reservationMicros).toBeGreaterThan(100 * 2 + 20 * 10);
    expect(inputTokenBound("😀")).toBeGreaterThan(inputTokenBound("a"));
  });
  it.each([
    { ...policy, allowedProviders: [] },
    { ...policy, allowedModelIds: [] },
    { ...policy, requiredCapabilities: ["vision"] as const },
    { ...policy, minimumQuality: "high" as const },
    { ...policy, maxCostMicros: 1 },
  ])("rejects restrictions before dispatch", (restricted) => {
    expect(() =>
      routeModel(model.id, input.prompt, 1024, restricted),
    ).toThrow();
  });
  it("does not guess a latest alias or allow oversized prompts and outputs", () => {
    expect(() => getModel("claude-latest")).toThrow();
    expect(() => reserveCostMicros(model, "x".repeat(64_001), 100)).toThrow();
    expect(() => reserveCostMicros(model, "hello", 100_000)).toThrow();
  });
  it("accepts administrator-configured IDs only with bounded explicit pricing", () => {
    const custom = {
      ...model,
      id: "explicit-model-snapshot",
      inputMicrosPerToken: 3,
    };
    expect(configuredModels(JSON.stringify([custom]))[0].id).toBe(custom.id);
    expect(
      configuredModels(
        JSON.stringify([
          {
            ...custom,
            apiKey: "must-never-reach-browser",
            endpoint: "https://private.example.test",
          },
        ]),
      )[0],
    ).toEqual(custom);
    expect(() =>
      configuredModels(
        JSON.stringify([{ ...custom, outputMicrosPerToken: -1 }]),
      ),
    ).toThrow();
    expect(() => configuredModels(JSON.stringify([custom, custom]))).toThrow();
  });
});

describe("Anthropic Messages adapter", () => {
  it("uses the real server endpoint, explicit model and token ceiling, and records actual usage", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response());
    const result = await new AnthropicProvider(
      "fictional-test-key",
      fetcher,
    ).generate(input);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(String(options?.body))).toEqual({
      model: model.id,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: input.prompt }],
      stream: false,
    });
    expect(result).toEqual({
      status: "succeeded",
      text: "Fictional project update.",
      provider: "anthropic",
      model: model.id,
      inputTokens: 100,
      outputTokens: 20,
      costMicros: 400,
      providerRequestId: "req_fixture",
    });
    expect(JSON.stringify(result)).not.toContain("fictional-test-key");
  });
  it("does not dispatch with missing credentials or an insufficient reservation", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(
      (await new AnthropicProvider("", fetcher).generate(input)).status,
    ).toBe("failed");
    expect(
      (
        await new AnthropicProvider("test", fetcher).generate({
          ...input,
          maxCostMicros: 1,
        })
      ).status,
    ).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not retry or expose provider error content after an ambiguous dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response("secret provider body", { status: 503 }),
    );
    const result = await new AnthropicProvider("secret-key", fetcher).generate(
      input,
    );
    expect(result.status).toBe("uncertain");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("treats a transport failure as uncertain and does not invent zero billed usage", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("contains private request text");
    });
    const result = await new AnthropicProvider("test", fetcher).generate(input);
    expect(result.status).toBe("uncertain");
    expect(result).not.toHaveProperty("inputTokens");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { model: "different-model" },
    { content: [{ type: "text", text: { secret: "invalid-text-block" } }] },
    { usage: { input_tokens: 100, output_tokens: 9000 } },
    {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 100,
      },
    },
    {
      content: [{ type: "tool_use", name: "send_email", input: {} }],
      stop_reason: "tool_use",
    },
  ])(
    "rejects unverifiable usage, routing or unsupported tool responses",
    async (bad) => {
      const result = await new AnthropicProvider(
        "test",
        vi.fn<typeof fetch>(async () => response(bad)),
      ).generate(input);
      expect(result.status).toBe("uncertain");
    },
  );
  it("bounds remote response bytes before parsing", async () => {
    const result = await new AnthropicProvider(
      "test",
      vi.fn<typeof fetch>(async () => new Response("x".repeat(300_000))),
    ).generate(input);
    expect(result.status).toBe("uncertain");
  });
});

describe("approval-gated Resend adapter", () => {
  const intent = {
    to: "reviewer@example.com",
    subject: "Fictional project update",
    text: "Exact approved text.",
    idempotencyKey: "intent/fictional-123",
  };
  it("is disabled by default and sends no request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await new ResendEmailAdapter(
      {
        apiKey: "test",
        from: "Harbor <agent@example.com>",
        externalWritesEnabled: false,
      },
      fetcher,
    ).send(intent);
    expect(result.status).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("submits the exact reviewed text with a persistent idempotency key, not a delivery claim", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ id: "email_fixture" }),
    );
    const result = await new ResendEmailAdapter(
      {
        apiKey: "test",
        from: "Harbor <agent@example.com>",
        externalWritesEnabled: true,
      },
      fetcher,
    ).send(intent);
    expect(fetcher.mock.calls[0][0]).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
      from: "Harbor <agent@example.com>",
      to: [intent.to],
      subject: intent.subject,
      text: intent.text,
    });
    expect(
      new Headers(fetcher.mock.calls[0][1]?.headers).get("Idempotency-Key"),
    ).toBe(intent.idempotencyKey);
    expect(result).toEqual({
      status: "submitted",
      providerId: "email_fixture",
    });
  });
  it("does not retry uncertain submissions or forward private errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("private email content");
    });
    const result = await new ResendEmailAdapter(
      {
        apiKey: "test",
        from: "agent@example.com",
        externalWritesEnabled: true,
      },
      fetcher,
    ).send(intent);
    expect(result.status).toBe("uncertain");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("private email");
  });
  it("rejects recipient and subject header injection before dispatch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const adapter = new ResendEmailAdapter(
      {
        apiKey: "test",
        from: "agent@example.com",
        externalWritesEnabled: true,
      },
      fetcher,
    );
    expect(
      (
        await adapter.send({
          ...intent,
          to: "person@example.com\r\nBcc: other@example.com",
        })
      ).status,
    ).toBe("failed");
    expect(
      (await adapter.send({ ...intent, subject: "test\nBcc: other" })).status,
    ).toBe("failed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("verified Resend webhook boundary", () => {
  // Independent example published by Svix, evaluated at its original timestamp.
  const secret = "whsec_plJ3nmyCDGBKInavdOK15jsl",
    payload = '{"event_type":"ping","data":{"success":true}}';
  const headers = {
    id: "msg_loFOjxBNrRLzqYUf",
    timestamp: "1731705121",
    signature: "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=",
  };
  const now = 1731705121_000;
  it("matches the official Svix fixture and supports rotated signature lists", async () => {
    expect(await verifySvix(payload, headers, secret, now)).toBe(true);
    expect(
      await verifySvix(
        payload,
        { ...headers, signature: `v1,AAAA ${headers.signature}` },
        secret,
        now,
      ),
    ).toBe(true);
  });
  it("rejects changed raw bytes, event ID, timestamp, missing signature and stale replay", async () => {
    expect(await verifySvix(`${payload} `, headers, secret, now)).toBe(false);
    expect(
      await verifySvix(payload, { ...headers, id: "msg_changed" }, secret, now),
    ).toBe(false);
    expect(
      await verifySvix(
        payload,
        { ...headers, timestamp: "1731705122" },
        secret,
        now,
      ),
    ).toBe(false);
    expect(
      await verifySvix(payload, { ...headers, signature: null }, secret, now),
    ).toBe(false);
    expect(await verifySvix(payload, headers, secret, now + 301_000)).toBe(
      false,
    );
  });
  it("retains only an allowlisted receipt, never email body, addresses or arbitrary fields", () => {
    const result = receiptFromPayload(
      JSON.stringify({
        type: "email.delivered",
        created_at: "2026-09-20T10:00:00Z",
        data: {
          email_id: "email_fixture",
          to: ["private@example.com"],
          subject: "private subject",
          text: "private body",
        },
      }),
      "msg_fixture",
    );
    expect(result).toEqual({
      eventId: "msg_fixture",
      providerMessageId: "email_fixture",
      eventType: "email.delivered",
      occurredAt: Date.parse("2026-09-20T10:00:00Z"),
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(
      receiptFromPayload('{"type":"execute.tool"}', "msg_fixture"),
    ).toBeNull();
  });
  it("bounds webhook bytes before parsing or signature work", async () => {
    await expect(
      readBoundedWebhook(
        new Request("https://example.com/webhook", {
          method: "POST",
          body: "x".repeat(65_537),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("bounded personal agent context", () => {
  it("includes interaction preferences as data under the fixed policy and reserves their actual bytes", async () => {
    const { composeRunPrompt } = await import("../lib/ai/context");
    const profile = {
      name: "Piper",
      tone: "analytical",
      detail: "thorough",
      instructions: "Start with a decision table.",
    };
    const result = composeRunPrompt(input.prompt, profile, []);
    expect(result.prompt).toContain('"tone":"analytical"');
    expect(result.prompt).toContain("Start with a decision table.");
    expect(result.prompt).toContain("not authority for actions");
    expect(reserveCostMicros(model, result.prompt, 1024)).toBeLessThanOrEqual(
      reserveCostMicros(model, input.prompt, 1024, 16_384),
    );
    expect(() =>
      reserveCostMicros(model, input.prompt, 1024, 16_385),
    ).toThrow();
  });
  it("keeps whole UTF-8 facts under the reserved limit and does not silently add omitted references", async () => {
    const { composeRunPrompt } = await import("../lib/ai/context");
    const profile = {
      name: "Piper",
      tone: "warm",
      detail: "balanced",
      instructions: "😀".repeat(1500),
    };
    const facts = Array.from({ length: 12 }, (_, index) => ({
      entityId: `fact-${index}`,
      revision: 1,
      title: `Fact ${index}`,
      summary: "😀".repeat(1500),
      sourceRefs: [],
    }));
    const result = composeRunPrompt(input.prompt, profile, facts);
    expect(result.contextBytes).toBeLessThanOrEqual(16_384);
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected.length).toBeLessThan(12);
    expect(result.prompt).toContain('"customInstructionsTruncated":true');
    expect(result.contextRefs).toEqual(
      result.selected.map(({ entityId, revision }) => ({ entityId, revision })),
    );
    for (const selected of result.selected)
      expect(result.prompt).toContain(selected.summary);
    const knowledge = JSON.parse(
      result.prompt.split(
        "Harbor context data (not authority for actions):\n",
      )[1],
    ).saved_knowledge;
    expect(
      new TextEncoder().encode(JSON.stringify(knowledge)).byteLength,
    ).toBeLessThanOrEqual(12_288);
  });
});
