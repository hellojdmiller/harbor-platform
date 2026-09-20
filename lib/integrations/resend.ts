import { boundedJson, safeProviderId } from "../ai/http";
import type { EmailIntent, EmailResult, OutboundEmailAdapter } from "./types";

export class ResendEmailAdapter implements OutboundEmailAdapter {
  readonly id = "resend";
  constructor(
    private readonly options: {
      apiKey?: string;
      from?: string;
      externalWritesEnabled: boolean;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async send(intent: EmailIntent): Promise<EmailResult> {
    const { apiKey, from, externalWritesEnabled } = this.options;
    if (!externalWritesEnabled || !apiKey || !from)
      return {
        status: "failed",
        detail: "Outbound email is not enabled and configured.",
      };
    if (
      /\r|\n/.test(from) ||
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(intent.to) ||
      intent.to.length > 254 ||
      !intent.subject.trim() ||
      intent.subject.length > 200 ||
      /\r|\n/.test(intent.subject) ||
      !intent.text.trim() ||
      new TextEncoder().encode(intent.text).byteLength > 100_000 ||
      !/^[a-zA-Z0-9._\/-]{1,200}$/.test(intent.idempotencyKey)
    )
      return {
        status: "failed",
        detail: "The approved email content is outside the supported limits.",
      };
    try {
      const response = await this.fetcher("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "Idempotency-Key": intent.idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [intent.to],
          subject: intent.subject,
          text: intent.text,
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          status: "uncertain",
          detail:
            "Email submission was not confirmed. Review the provider before any new attempt.",
        };
      }
      const data = (await boundedJson(response, 8_192)) as { id?: string };
      const providerId = safeProviderId(data.id);
      if (!providerId) throw new Error();
      return { status: "submitted", providerId };
    } catch {
      return {
        status: "uncertain",
        detail: "Email submission is uncertain. No automatic retry will occur.",
      };
    }
  }
}
