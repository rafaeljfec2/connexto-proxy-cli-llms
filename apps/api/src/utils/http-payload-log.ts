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

const IMAGE_DATA_REDACTED = "[REDACTED:image-data]";
/** Data URLs that carry base64 bytes or an image MIME type, with or without a subtype. */
const DATA_URL_PATTERN = /^data:(?:[^,]*;\s*base64\s*,|image[^,]*,)/i;
/** Base64 runs long enough to be image bytes, found inside image context. */
const BASE64_RUN_PATTERN = /^[A-Za-z0-9+/=\s]{256,}$/;
const IMAGE_URL_KEY = /^(url|image_url)$/i;
const IMAGE_MIME_KEYS = ["mimeType", "mime_type", "media_type"] as const;

/**
 * Redacts sensitive JSON values. Image payloads are never logged: data URLs are
 * replaced, base64 data inside an image context (an image part, or any value
 * nested under one) is replaced, and image URLs keep only origin and path
 * because query strings may carry signed credentials.
 */
export function redactSensitiveJson(value: unknown): unknown {
  return redactValue(value, undefined, false);
}

function redactValue(
  value: unknown,
  key: string | undefined,
  inImageContext: boolean,
): unknown {
  if (typeof value === "string") {
    return redactString(value, key, inImageContext);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, undefined, inImageContext));
  }
  const record = value as Record<string, unknown>;
  const childContext = inImageContext || isImageRecord(record);
  const out: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(record)) {
    if (SENSITIVE_JSON_KEY.test(entryKey)) {
      out[entryKey] = REDACTED;
    } else {
      out[entryKey] = redactValue(entry, entryKey, childContext);
    }
  }
  return out;
}

function isImageRecord(record: Record<string, unknown>): boolean {
  const typeValue = record.type;
  if (typeof typeValue === "string" && /image/i.test(typeValue)) {
    return true;
  }
  return IMAGE_MIME_KEYS.some((mimeKey) => {
    const mimeValue = record[mimeKey];
    return typeof mimeValue === "string" && /^\s*image\//i.test(mimeValue);
  });
}

function redactString(
  value: string,
  key: string | undefined,
  inImageContext: boolean,
): string {
  if (DATA_URL_PATTERN.test(value)) {
    return IMAGE_DATA_REDACTED;
  }
  if (inImageContext && (key === "data" || BASE64_RUN_PATTERN.test(value))) {
    return IMAGE_DATA_REDACTED;
  }
  if (key !== undefined && IMAGE_URL_KEY.test(key) && /^https?:\/\//i.test(value)) {
    return stripUrlQuery(value);
  }
  return value;
}

/** Redacts a raw, non-JSON text body (for example a data URL echoed as text). */
export function redactRawText(text: string): string {
  return redactString(text, undefined, false);
}

function stripUrlQuery(value: string): string {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[REDACTED:url]";
  }
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
    const safe = redactRawText(trimmed);
    const byteLength = Buffer.byteLength(safe, "utf8");
    if (byteLength <= maxBytes) {
      return safe;
    }
    return {
      __truncated: true,
      byteLength,
      preview: safe.slice(0, maxBytes),
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
