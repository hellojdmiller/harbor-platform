export async function boundedJson(
  response: Response,
  maxBytes = 256_000,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Empty provider response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw new Error("Provider response limit exceeded");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function safeProviderId(
  value: string | null | undefined,
): string | undefined {
  return value && /^[a-zA-Z0-9_-]{1,160}$/.test(value) ? value : undefined;
}
