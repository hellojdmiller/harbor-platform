// Svix v1 protocol: HMAC-SHA256 over id.timestamp.raw_body, verified using WebCrypto.
// https://docs.svix.com/receiving/verifying-payloads/how-manual
export interface SvixHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}
function base64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("Invalid signature encoding");
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
export async function verifySvix(
  payload: string,
  headers: SvixHeaders,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  if (
    !headers.id ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(headers.id) ||
    !headers.timestamp ||
    !/^\d{1,12}$/.test(headers.timestamp) ||
    !headers.signature ||
    headers.signature.length > 2_048 ||
    new TextEncoder().encode(payload).byteLength > 65_536 ||
    !secret.startsWith("whsec_")
  )
    return false;
  const seconds = Number(headers.timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > 300)
    return false;
  try {
    const material = base64(secret.slice(6));
    if (material.length < 16 || material.length > 128) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      material,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signed = new TextEncoder().encode(
      `${headers.id}.${headers.timestamp}.${payload}`,
    );
    for (const signature of headers.signature.split(" ")) {
      const [version, encoded, extra] = signature.split(",");
      if (version !== "v1" || !encoded || extra) continue;
      try {
        if (await crypto.subtle.verify("HMAC", key, base64(encoded), signed))
          return true;
      } catch {
        /* Try the next rotation signature. */
      }
    }
  } catch {
    return false;
  }
  return false;
}
const supportedEvents = new Set([
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.received",
]);
export function receiptFromPayload(payload: string, eventId: string) {
  const value: unknown = JSON.parse(payload);
  if (!value || typeof value !== "object") return null;
  const body = value as {
    type?: unknown;
    created_at?: unknown;
    data?: { email_id?: unknown };
  };
  if (
    typeof body.type !== "string" ||
    !supportedEvents.has(body.type) ||
    typeof body.created_at !== "string" ||
    typeof body.data?.email_id !== "string" ||
    !/^[a-zA-Z0-9_-]{1,160}$/.test(body.data.email_id)
  )
    return null;
  const occurredAt = Date.parse(body.created_at);
  if (!Number.isFinite(occurredAt)) return null;
  // No addresses, subject, message body, attachments, URLs or arbitrary event fields are retained.
  return {
    eventId,
    providerMessageId: body.data.email_id,
    eventType: body.type,
    occurredAt,
  };
}
export async function readBoundedWebhook(
  request: Request,
  maximum = 65_536,
): Promise<string> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maximum) throw new Error("Payload exceeds the limit");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing payload");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new Error("Payload exceeds the limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
