import { registerOTel, OTLPHttpJsonTraceExporter } from "@vercel/otel";
import { redactingExporter } from "./lib/telemetry";
export function register() {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  registerOTel({
    serviceName: "harbor-web",
    instrumentations: [],
    attributesFromHeaders: () => ({}),
    traceExporter: redactingExporter(new OTLPHttpJsonTraceExporter()),
    autoDetectResources: false,
  });
}
