import { HttpError } from "@agent-runtime-gateway/compatibility-openai";
import type { CursorDeps, CursorEnv } from "../engine/types.js";
import { cursorBackendUrl, cursorUpstreamError } from "../engine/auth-api.js";
import { DEFAULT_SDK_CLIENT_VERSION, SDK_STREAM_START_TIMEOUT_MS } from "./types.js";

export async function writeSdkUpload(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  frame: Uint8Array,
): Promise<void> {
  await writer.write(frame).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
}

export async function closeSdkUpload(
  writer: WritableStreamDefaultWriter<Uint8Array>,
): Promise<void> {
  await writer.close().catch(() => undefined);
  writer.releaseLock();
}

export function withSdkStartTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new HttpError(
          "Cursor local SDK stream did not start.",
          504,
          "cursor_sdk_stream_timeout",
        ),
      );
    }, SDK_STREAM_START_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function cursorLocalSdkEndpoint(env: CursorEnv): string {
  const endpoint = env.CURSOR_LOCAL_AGENT_ENDPOINT?.trim();
  if (!endpoint) {
    throw new HttpError(
      "Cursor local SDK endpoint is not configured",
      500,
      "cursor_missing_endpoint",
    );
  }
  return endpoint;
}

export function parseCursorSdkError(text: string): { message?: string; code?: string } {
  try {
    const payload: unknown = JSON.parse(text);
    if (isRecord(payload)) {
      const error = isRecord(payload.error) ? payload.error : payload;
      return {
        message: typeof error.message === "string" ? error.message : undefined,
        code: typeof error.code === "string" ? error.code : undefined,
      };
    }
  } catch {
    // Ignore invalid JSON error bodies and preserve their text below.
  }
  return { message: text || undefined };
}

export async function cursorLocalSdkRaw(
  env: CursorEnv,
  deps: CursorDeps,
  endpoint: string,
  accessToken: string,
  requestId: string,
  body: string | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): Promise<Response> {
  const url = cursorBackendUrl(env, endpoint);
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "Connect-Protocol-Version": "1",
    "Content-Type": "application/connect+proto",
    "User-Agent": "connect-es/1.6.1",
    "x-cursor-client-type": "sdk",
    "x-cursor-client-version":
      env.CURSOR_SDK_CLIENT_VERSION ?? DEFAULT_SDK_CLIENT_VERSION,
    "x-ghost-mode": "true",
    "x-original-request-id": requestId,
    "x-request-id": requestId,
  });
  const init: RequestInit & { duplex?: "half" } = {
    method: "POST",
    headers,
    body,
    signal,
  };
  if (body instanceof ReadableStream) init.duplex = "half";
  const response = await deps.fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const parsed = parseCursorSdkError(text);
    throw cursorUpstreamError(response.status, {
      message:
        parsed.message ??
        `Cursor local SDK request failed with status ${response.status}`,
      code: parsed.code ?? "cursor_sdk_error",
    });
  }
  return response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
