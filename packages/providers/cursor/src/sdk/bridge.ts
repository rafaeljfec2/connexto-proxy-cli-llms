import {
  HttpError,
  isRecord,
  type CursorToolCall,
} from "@agent-runtime-gateway/compatibility-openai";
import type { CursorDeps, CursorEnv } from "../engine/types.js";
import { cursorBackendUrl, cursorUpstreamError } from "../engine/auth-api.js";
import type {
  ClientToolSpec,
  ContainerBridgeBinding,
  CursorSdkBridgeOutput,
} from "./types.js";
import {
  DEFAULT_SDK_BRIDGE_REQUEST_TIMEOUT_MS,
  DEFAULT_SDK_CLIENT_VERSION,
  SDK_STREAM_START_TIMEOUT_MS,
} from "./types.js";
import { sdkWorkingDirectory } from "./proto.js";

export function hasCursorSdkBridge(env: CursorEnv): boolean {
  return Boolean(env.CURSOR_SDK_BRIDGE_CONTAINER || env.CURSOR_SDK_BRIDGE_URL?.trim());
}

export function bridgeClientTools(
  tools: ClientToolSpec[] | undefined,
): ClientToolSpec[] {
  return (tools ?? []).flatMap((tool) => {
    const name = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!name) return [];
    return [
      {
        name,
        ...(typeof tool.description === "string" && tool.description
          ? { description: tool.description }
          : {}),
        ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
      },
    ];
  });
}

export function cursorLocalSdkBridgeHeaders(env: CursorEnv): Headers {
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (env.CURSOR_SDK_BRIDGE_TOKEN?.trim()) {
    headers.set("Authorization", `Bearer ${env.CURSOR_SDK_BRIDGE_TOKEN.trim()}`);
  }
  return headers;
}

export function cursorLocalSdkBridgeTimeoutMs(env: CursorEnv): number {
  const value = Number.parseInt(env.CURSOR_SDK_BRIDGE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SDK_BRIDGE_REQUEST_TIMEOUT_MS;
}

export async function withCursorLocalSdkBridgeTimeout<T>(
  env: CursorEnv,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = cursorLocalSdkBridgeTimeoutMs(env);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = run(controller.signal);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new HttpError(
        "Cursor SDK bridge request timed out.",
        504,
        "cursor_sdk_bridge_timeout",
      );
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => undefined);
  }
}

export async function parseCursorLocalSdkBridgeJsonResponse(
  response: Response,
): Promise<CursorSdkBridgeOutput> {
  const text = await response.text().catch(() => "");
  let object: unknown;
  if (text.trim()) {
    try {
      object = JSON.parse(text);
    } catch {
      throw new HttpError(
        "Cursor SDK bridge returned invalid JSON",
        502,
        "cursor_sdk_bridge_invalid_json",
      );
    }
  } else {
    object = {};
  }
  if (!response.ok) {
    const error = isRecord(object) && isRecord(object.error) ? object.error : undefined;
    const message =
      typeof error?.message === "string" && error.message
        ? error.message
        : `Cursor SDK bridge failed with status ${response.status}`;
    const code =
      typeof error?.code === "string" && error.code
        ? error.code
        : "cursor_sdk_bridge_error";
    const status =
      response.status === 401
        ? 502
        : response.status === 429
          ? 429
          : response.status >= 500
            ? 502
            : 400;
    throw new HttpError(message, status, code);
  }
  if (!isRecord(object)) {
    throw new HttpError(
      "Cursor SDK bridge returned invalid JSON",
      502,
      "cursor_sdk_bridge_invalid_json",
    );
  }
  return {
    text: typeof object.text === "string" ? object.text : "",
    toolCalls: Array.isArray(object.toolCalls)
      ? object.toolCalls.flatMap(cursorToolCallFromJson)
      : [],
    agentID: typeof object.agentID === "string" ? object.agentID : undefined,
    runID: typeof object.runID === "string" ? object.runID : undefined,
    status: typeof object.status === "string" ? object.status : undefined,
  };
}

export function cursorToolCallFromJson(value: unknown): CursorToolCall[] {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim())
    return [];
  return [
    {
      name: value.name.trim(),
      arguments: isRecord(value.arguments) ? value.arguments : {},
    },
  ];
}

export async function cursorLocalSdkBridgeJson(
  env: CursorEnv,
  deps: CursorDeps,
  apiKey: string,
  input: {
    agentId: string;
    runId: string;
    sessionKey: string;
    prompt: string;
    modelId: string;
    workingDirectory?: string;
    clientTools?: ClientToolSpec[];
  },
): Promise<CursorSdkBridgeOutput> {
  const body = JSON.stringify({
    apiKey,
    requestId: input.runId,
    model: input.modelId,
    prompt: input.prompt,
    sessionKey: input.sessionKey || input.agentId,
    workingDirectory: sdkWorkingDirectory(input.workingDirectory),
    tools: bridgeClientTools(input.clientTools),
  });
  const bridgeBinding = env.CURSOR_SDK_BRIDGE_CONTAINER as
    ContainerBridgeBinding | undefined;
  const bridgeUrl = env.CURSOR_SDK_BRIDGE_URL?.trim();
  const response = await withCursorLocalSdkBridgeTimeout(env, (signal) =>
    bridgeBinding
      ? cursorLocalSdkContainerBridgeJson(env, bridgeBinding, body, signal)
      : bridgeUrl
        ? cursorLocalSdkUrlBridgeJson(env, deps, bridgeUrl, body, signal)
        : Promise.resolve(undefined),
  );
  if (!response)
    throw new HttpError(
      "Cursor SDK bridge is not configured",
      500,
      "cursor_sdk_bridge_missing",
    );
  return parseCursorLocalSdkBridgeJsonResponse(response);
}

export async function cursorLocalSdkUrlBridgeJson(
  env: CursorEnv,
  deps: CursorDeps,
  bridgeUrl: string,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  return deps.fetch(bridgeUrl, {
    method: "POST",
    headers: cursorLocalSdkBridgeHeaders(env),
    body,
    signal,
  });
}

export async function cursorLocalSdkContainerBridgeJson(
  env: CursorEnv,
  bridgeBinding: ContainerBridgeBinding,
  body: string,
  signal?: AbortSignal,
): Promise<Response> {
  const bridgeId = bridgeBinding.idFromName("shared");
  const bridge = bridgeBinding.get(bridgeId);
  return await bridge.fetch("http://cursor-sdk-bridge.local/sdk", {
    method: "POST",
    headers: cursorLocalSdkBridgeHeaders(env),
    body,
    signal,
  });
}

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
  if (!endpoint)
    throw new HttpError(
      "Cursor local SDK endpoint is not configured",
      500,
      "cursor_missing_endpoint",
    );
  return endpoint;
}

export function parseCursorSdkError(text: string): { message?: string; code?: string } {
  try {
    const payload = JSON.parse(text) as unknown;
    if (isRecord(payload)) {
      const error = isRecord(payload.error) ? payload.error : payload;
      return {
        message: typeof error.message === "string" ? error.message : undefined,
        code: typeof error.code === "string" ? error.code : undefined,
      };
    }
  } catch {
    // Ignore JSON parse failures.
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
