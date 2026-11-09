import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  AntigravityMcpBridgeOptions,
  McpBridgeToolCallRequest,
  McpBridgeToolCallResult,
  McpServerConfig,
} from "./types.js";
import { sanitizeMcpToolSchema } from "./schema.js";

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";

export class AntigravityMcpBridge {
  private server?: net.Server;
  private readonly socketPath: string;
  private readonly sockets = new Set<net.Socket>();
  private readonly options: AntigravityMcpBridgeOptions;
  private isDisposed = false;

  constructor(options: AntigravityMcpBridgeOptions) {
    this.options = options;
    const runId = randomUUID().replaceAll("-", "");
    this.socketPath = `/tmp/agy-mcp-${runId}.sock`;
  }

  public get socketAddress(): string {
    return this.socketPath;
  }

  public async start(): Promise<McpServerConfig> {
    if (this.isDisposed) {
      throw new Error("Cannot start a disposed AntigravityMcpBridge.");
    }
    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch {
      // ignore
    }

    this.server = net.createServer((socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    const dirname = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.join(dirname, "bridge-worker.mjs");

    return {
      name: "connexto_tools",
      command: "node",
      args: [workerPath, this.socketPath],
      env: [],
    };
  }

  public async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.isDisposed = true;

    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.sockets.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = undefined;
    }

    try {
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    } catch {
      // ignore
    }
  }

  private handleConnection(socket: net.Socket): void {
    if (this.isDisposed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));

    const rl = readline.createInterface({ input: socket, terminal: false });

    const send = (msg: unknown): void => {
      if (!socket.writable) return;
      socket.write(JSON.stringify(msg) + "\n");
    };

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: { id?: unknown; method?: string; params?: unknown };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      const { id, method, params } = parsed;

      if (method === "initialize") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "antigravity-mcp-bridge", version: "1.0.0" },
          },
        });
      } else if (method === "notifications/initialized") {
        // notification acknowledged
      } else if (method === "tools/list") {
        const tools = this.options.tools.map((spec) => ({
          name: spec.name,
          description: spec.description ?? "",
          inputSchema: sanitizeMcpToolSchema(spec.parameters),
        }));
        send({
          jsonrpc: "2.0",
          id,
          result: { tools },
        });
      } else if (method === "tools/call") {
        const callParams = (params ?? {}) as { name?: string; arguments?: unknown };
        const toolName = callParams.name ?? "";
        const args = (
          typeof callParams.arguments === "object" && callParams.arguments !== null
            ? callParams.arguments
            : {}
        ) as Record<string, unknown>;

        const callId = `call_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
        const callRequest: McpBridgeToolCallRequest = {
          callId,
          name: toolName,
          arguments: args,
        };

        this.options.onToolCall?.(callRequest);

        const result = await this.executeToolWithSafety(callRequest);
        this.options.onToolResult?.(callId, result);

        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: result.output }],
            isError: result.isError ?? false,
          },
        });
      } else if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${String(method)}` },
        });
      }
    });
  }

  private async executeToolWithSafety(
    call: McpBridgeToolCallRequest,
  ): Promise<McpBridgeToolCallResult> {
    const isDeclared = this.options.tools.some((t) => t.name === call.name);
    const policy = this.options.policies?.[call.name];

    // 1. Explicit denial policy
    if (policy && policy.allowed === false) {
      return {
        output: `Permission denied: execution of tool '${call.name}' is explicitly rejected by policy.`,
        isError: true,
      };
    }

    // 2. Custom or test executor
    if (this.options.executor) {
      const timeoutMs = this.options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
      return new Promise<McpBridgeToolCallResult>((resolve) => {
        const timer = setTimeout(() => {
          resolve({
            output: `Tool call '${call.name}' timed out after ${timeoutMs}ms.`,
            isError: true,
          });
        }, timeoutMs);

        this.options.executor!(call)
          .then((res) => {
            clearTimeout(timer);
            resolve(res);
          })
          .catch((err) => {
            clearTimeout(timer);
            resolve({
              output: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            });
          });
      });
    }

    // 3. Option A (Default): Delegate to external consumer
    if (isDeclared) {
      return {
        output: `[DELEGATED_TO_CLIENT: tool_call_id=${call.callId}] Tool '${call.name}' execution delegated to external consumer. Awaiting consumer result.`,
      };
    }

    // 4. Default safe denial for unknown tools without declared policy
    return {
      output: `Permission denied: tool '${call.name}' has no declared authorization policy.`,
      isError: true,
    };
  }
}

