import {
  HttpError,
  isRecord,
  type CursorMe,
} from "@agent-runtime-gateway/compatibility-openai";
import type {
  CursorAccessTokenResponse,
  CursorDeps,
  CursorEnv,
  CursorModelResponse,
} from "./types.js";
import { base64Url, sha256Hex } from "./utils.js";

export const cursorIdentityCache = new Map<
  string,
  { identity: string; expiresAt: number }
>();

export function evictExpiredCacheEntries(now: number): void {
  for (const [key, entry] of cursorIdentityCache.entries()) {
    if (entry.expiresAt <= now) cursorIdentityCache.delete(key);
  }
}

export async function verifyCursorApiKey(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
): Promise<CursorMe> {
  return cursorPublicJson<CursorMe>(env, deps, apiKey, "/v1/me");
}

export async function listCursorModels(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
): Promise<CursorModelResponse> {
  return cursorPublicJson<CursorModelResponse>(env, deps, apiKey, "/v1/models");
}

export async function exchangeCursorApiKey(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
): Promise<string> {
  const response = await cursorInternalRaw(
    env,
    deps,
    apiKey,
    "/auth/exchange_user_api_key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  const payload = (await response.json()) as CursorAccessTokenResponse;
  if (!payload.accessToken)
    throw new HttpError(
      "Cursor did not return an internal access token",
      502,
      "cursor_bad_response",
    );
  return payload.accessToken;
}

export async function getCursorAccountIdentity(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
): Promise<string> {
  const apiKeyHash = await sha256Hex(apiKey);
  const now = deps.now().getTime();
  const cached = cursorIdentityCache.get(apiKeyHash);
  if (cached && cached.expiresAt > now) return cached.identity;
  if (cached) cursorIdentityCache.delete(apiKeyHash);

  const me = await verifyCursorApiKey(env, deps, apiKey);
  const identity =
    typeof me.userId === "number"
      ? `cursor-user:${me.userId}`
      : me.userEmail
        ? `cursor-email:${me.userEmail.trim().toLowerCase()}`
        : `cursor-key:${apiKeyHash}`;

  cursorIdentityCache.set(apiKeyHash, { identity, expiresAt: now + 60 * 60 * 1000 });
  evictExpiredCacheEntries(now);
  return identity;
}

export async function cursorPublicJson<T>(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
  };
  const response = await cursorPublicRaw(env, deps, apiKey, path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return response.json() as Promise<T>;
}

export async function cursorPublicRaw(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const base = env.CURSOR_API_BASE ?? "https://api.cursor.com";
  const url = `${base.replace(/\/$/, "")}${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  headers.set("x-cursor-client-type", "sdk");
  headers.set("x-cursor-client-version", "composer-api-0.1.0");
  headers.set("x-ghost-mode", "true");
  const response = await deps.fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw cursorUpstreamError(response.status, {
      message:
        parseCursorError(text) ??
        `Cursor API request failed with status ${response.status}`,
      code: "cursor_api_error",
    });
  }
  return response;
}

/** Cursor-specific status returned when it refuses a proxied account/session. */
const CURSOR_REJECTED_SESSION_STATUS = 464;

export async function cursorInternalRaw(
  env: CursorEnv,
  deps: CursorDeps,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = cursorBackendUrl(env, path);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const response = await deps.fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw cursorUpstreamError(response.status, {
      message:
        parseCursorError(text) ??
        (response.status === CURSOR_REJECTED_SESSION_STATUS
          ? "Cursor rejected the proxied chat request. The proxy request is valid, but Cursor refused this account/session."
          : `Cursor internal API request failed with status ${response.status}`),
      code: "cursor_api_error",
      badGatewayStatuses: [CURSOR_REJECTED_SESSION_STATUS],
    });
  }
  return response;
}

/**
 * Resolves a Cursor backend path (or absolute URL) against
 * `CURSOR_BACKEND_BASE_URL`. The base URL is required even for absolute URLs.
 */
export function cursorBackendUrl(env: CursorEnv, pathOrUrl: string): string {
  const base = env.CURSOR_BACKEND_BASE_URL?.trim();
  if (!base)
    throw new HttpError(
      "Cursor backend URL is not configured",
      500,
      "cursor_missing_backend_url",
    );
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  const normalizedPath = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${base.replace(/\/$/, "")}${normalizedPath}`;
}

/**
 * Maps a failed Cursor upstream response to the gateway error contract:
 * 401 and 429 are preserved, 5xx (plus any extra bad-gateway statuses)
 * become 502 and everything else becomes 400.
 */
export function cursorUpstreamError(
  upstreamStatus: number,
  details: { message: string; code: string; badGatewayStatuses?: readonly number[] },
): HttpError {
  if (upstreamStatus === 401) {
    return new HttpError("Invalid Cursor API key", 401, "cursor_unauthorized");
  }
  const isBadGateway =
    upstreamStatus >= 500 ||
    (details.badGatewayStatuses ?? []).includes(upstreamStatus);
  const status = upstreamStatus === 429 ? 429 : isBadGateway ? 502 : 400;
  return new HttpError(details.message, status, details.code);
}

export function cursorChatEndpoint(env: CursorEnv): string {
  const endpoint = env.CURSOR_CHAT_ENDPOINT?.trim();
  if (!endpoint)
    throw new HttpError(
      "Cursor chat endpoint is not configured",
      500,
      "cursor_missing_endpoint",
    );
  return endpoint;
}

export function parseCursorError(text: string): string | undefined {
  try {
    const payload = JSON.parse(text) as unknown;
    if (isRecord(payload)) {
      const error = isRecord(payload.error) ? payload.error : payload;
      if (typeof error.message === "string") return error.message;
    }
  } catch {
    // Ignore JSON parse failures.
  }
  return text || undefined;
}

export async function cursorInternalHeaders(
  env: CursorEnv,
  accessToken: string,
  cursorIdentity: string,
  requestId: string,
): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/connect+proto",
    "Connect-Protocol-Version": "1",
    "User-Agent": "connect-es/1.6.1",
    "x-amzn-trace-id": `Root=${requestId}`,
    "x-client-key": await sha256Hex(accessToken),
    "x-cursor-checksum": await cursorChecksum(env, cursorIdentity),
    "x-cursor-client-version": env.CURSOR_CLIENT_VERSION ?? "2.6.22",
    "x-cursor-client-type": "ide",
    "x-cursor-client-os": "linux",
    "x-cursor-client-arch": "x64",
    "x-cursor-client-os-version": "unknown",
    "x-cursor-client-device-type": "desktop",
    "x-cursor-config-version": await stableUuid("cursor-config", cursorIdentity),
    "x-cursor-timezone": "UTC",
    "x-ghost-mode": "false",
    "x-new-onboarding-completed": "false",
    "x-request-id": requestId,
    "x-session-id": await sessionId(accessToken),
  };
}

export async function cursorChecksum(
  env: CursorEnv,
  cursorIdentity: string,
): Promise<string> {
  const machineId = await sha256Hex(
    `${env.ENCRYPTION_KEY ?? "composer-api"}:cursor-machine:${cursorIdentity}`,
  );
  const timestamp = BigInt(Math.floor(Date.now() / 1_000_000));
  const bytes = new Uint8Array([
    Number((timestamp >> 40n) & 255n),
    Number((timestamp >> 32n) & 255n),
    Number((timestamp >> 24n) & 255n),
    Number((timestamp >> 16n) & 255n),
    Number((timestamp >> 8n) & 255n),
    Number(timestamp & 255n),
  ]);
  let t = 165;
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = ((bytes[i] ^ t) + (i % 256)) & 255;
    t = bytes[i];
  }
  return `${base64Url(bytes)}${machineId}`;
}

export async function stableUuid(namespace: string, value: string): Promise<string> {
  const hash = (await sha256Hex(`${namespace}:${value}`)).slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}

export async function sessionId(token: string): Promise<string> {
  const hash = (await sha256Hex(token)).slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
}
