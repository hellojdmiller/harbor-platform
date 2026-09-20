// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { OTLPHttpJsonTraceExporter } from "@vercel/otel";
import { redactSpan, redactingExporter } from "../lib/telemetry";
it("serializes a real SDK span through a redacted OTLP exporter", async () => {
  const memory = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memory)],
  });
  const span = provider
    .getTracer("private-vendor")
    .startSpan("secret-person@example.invalid");
  span.setAttribute("prompt", "private secret body");
  span.setAttribute("http.status_code", 200);
  span.recordException(new Error("secret credential"));
  span.end();
  await provider.forceFlush();
  const real = memory.getFinishedSpans()[0];
  const redacted = redactSpan(real);
  expect(redacted.spanContext().traceId).toBe(real.spanContext().traceId);
  let body = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init: RequestInit) => {
      body = String(init.body);
      return new Response("", { status: 200 });
    }),
  );
  const exporter = redactingExporter(
    new OTLPHttpJsonTraceExporter({
      url: "https://telemetry.example.invalid/v1/traces",
    }),
  );
  try {
    await new Promise<void>((resolve, reject) =>
      exporter.export([real], (result) =>
        result.code === 0 ? resolve() : reject(result.error),
      ),
    );
    expect(body).toContain("harbor-web");
    expect(body).toContain("harbor.request");
    expect(body).not.toContain("secret");
    expect(body).not.toContain("private");
    expect(body).toContain(real.spanContext().traceId);
  } finally {
    vi.unstubAllGlobals();
    await exporter.shutdown();
    await provider.shutdown();
  }
});
