const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-gateway-api-key",
  "proxy-authorization",
]);

const SENSITIVE_JSON_KEY =
  /^(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token|credential|authorization|code|authorization[_-]?code)$/i;

const REDACTED = "[REDACTED]";

export type TruncatedPayload = Readonly<{
  __truncated: true;
  byteLength: number;
  preview: string;
}>;

export function sanitizeRequestHeaders(
  headers: Record<string, unknown>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      out[name] = REDACTED;
      continue;
    }
    if (typeof value === "string" || Array.isArray(value)) {
      out[name] = value;
    }
  }
  return out;
}

export function redactSensitiveJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitiveJson(entry));
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (SENSITIVE_JSON_KEY.test(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = redactSensitiveJson(entry);
    }
  }
  return out;
}

export function serializePayloadForLog(value: unknown, maxBytes: number): unknown {
  if (value === undefined) {
    return undefined;
  }
  const redacted = redactSensitiveJson(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    return { __nonSerializable: true };
  }
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength <= maxBytes) {
    return redacted;
  }
  const preview = serialized.slice(0, maxBytes);
  return {
    __truncated: true,
    byteLength,
    preview,
  } satisfies TruncatedPayload;
}

export function parseResponseBodyForLog(
  raw: string,
  contentType: string | undefined,
  maxBytes: number,
): unknown {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (contentType?.includes("text/event-stream")) {
    return serializePayloadForLog(parseSsePayload(trimmed), maxBytes);
  }
  try {
    return serializePayloadForLog(JSON.parse(trimmed) as unknown, maxBytes);
  } catch {
    const byteLength = Buffer.byteLength(trimmed, "utf8");
    if (byteLength <= maxBytes) {
      return trimmed;
    }
    return {
      __truncated: true,
      byteLength,
      preview: trimmed.slice(0, maxBytes),
    } satisfies TruncatedPayload;
  }
}

function parseSsePayload(raw: string): unknown {
  const events: unknown[] = [];
  const blocks = raw.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    if (data === "[DONE]") {
      events.push("[DONE]");
      continue;
    }
    try {
      events.push(JSON.parse(data) as unknown);
    } catch {
      events.push(data);
    }
  }
  return events;
}
