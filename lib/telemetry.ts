import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SpanContext } from "@opentelemetry/api";
const safeKeys = new Set([
  "http.request.method",
  "http.response.status_code",
  "http.method",
  "http.status_code",
  "harbor.operation",
  "harbor.outcome",
  "harbor.duration_ms",
]);
function safeContext(ctx: SpanContext): SpanContext {
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    traceFlags: ctx.traceFlags,
  };
}
// Explicit projection preserves SDK prototype methods while excluding any private fields.
export function redactSpan(span: ReadableSpan): ReadableSpan {
  return {
    name: "harbor.request",
    kind: span.kind,
    spanContext: () => safeContext(span.spanContext()),
    parentSpanContext: span.parentSpanContext
      ? safeContext(span.parentSpanContext)
      : undefined,
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    attributes: Object.fromEntries(
      Object.entries(span.attributes).filter(
        ([k, v]) =>
          safeKeys.has(k) &&
          (typeof v === "number" ||
            typeof v === "boolean" ||
            (typeof v === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(v))),
      ),
    ),
    events: [],
    links: [],
    status: { code: span.status.code },
    resource: resourceFromAttributes({ "service.name": "harbor-web" }),
    instrumentationScope: { name: "harbor" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}
export function redactingExporter(exporter: SpanExporter): SpanExporter {
  return {
    export(spans, callback) {
      exporter.export(spans.map(redactSpan), callback);
    },
    shutdown: () => exporter.shutdown(),
    forceFlush: () => exporter.forceFlush?.() ?? Promise.resolve(),
  };
}
