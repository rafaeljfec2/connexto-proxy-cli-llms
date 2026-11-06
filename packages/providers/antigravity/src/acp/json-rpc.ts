import type {
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  InvalidLineListener,
} from "./types.js";

export function buildRequest(
  id: number,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

export function buildNotification(
  method: string,
  params?: unknown,
): JsonRpcNotification {
  return params === undefined
    ? { jsonrpc: "2.0", method }
    : { jsonrpc: "2.0", method, params };
}

export function serializeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function isValidMessageShape(value: unknown): value is JsonRpcMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate["jsonrpc"] !== "2.0") {
    return false;
  }
  if (typeof candidate["method"] === "string") {
    return true;
  }
  return candidate["id"] !== undefined;
}

/**
 * Incremental decoder for newline-delimited JSON-RPC messages.
 *
 * Non-JSON lines are never parsed as protocol data: the raw line is deferred to
 * the `onInvalidLine` listener, so callers can optionally report noise without
 * treating it as agent output.
 */
export class MessageStreamDecoder {
  private buffer = "";
  private readonly onInvalidLine: InvalidLineListener;

  constructor(onInvalidLine: InvalidLineListener = () => {}) {
    this.onInvalidLine = onInvalidLine;
  }

  public push(chunk: string): JsonRpcMessage[] {
    this.buffer += chunk;
    const messages: JsonRpcMessage[] = [];

    while (this.buffer.includes("\n")) {
      const newlineIndex = this.buffer.indexOf("\n");
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.length > 0) {
        const message = decodeLine(line);
        if (message) {
          messages.push(message);
        } else {
          this.onInvalidLine(line);
        }
      }
    }

    return messages;
  }

  public flush(): JsonRpcMessage[] {
    const trailing = this.buffer.trim();
    this.buffer = "";
    if (trailing.length === 0) {
      return [];
    }
    const message = decodeLine(trailing);
    if (message) {
      return [message];
    }
    this.onInvalidLine(trailing);
    return [];
  }
}

function decodeLine(line: string): JsonRpcMessage | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    if (isValidMessageShape(parsed)) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
