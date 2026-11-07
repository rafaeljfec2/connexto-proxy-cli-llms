import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  type AgentOptions,
  type RunResult,
  type RunStatus,
  type SDKCustomTool,
  type SDKCustomToolResult,
  type SDKImage,
  type SDKJsonValue,
  type SDKMessage,
  type SDKUserMessage,
} from "@cursor/sdk";
import { isRecord } from "@agent-runtime-gateway/compatibility-openai";
import type { CursorToolCall } from "@agent-runtime-gateway/compatibility-openai";
import type {
  AgentImageInput,
  CursorClientToolSpec,
} from "@agent-runtime-gateway/core";
import { CursorProviderError } from "./provider-error.js";
import type { CursorTextEvent } from "./engine/types.js";
import type { CursorSdkCompletion } from "./sdk/types.js";

interface CursorSdkRun {
  readonly id: string;
  readonly status: RunStatus;
  stream(): AsyncGenerator<SDKMessage>;
  wait(): Promise<RunResult>;
  cancel(): Promise<void>;
}

interface CursorSdkAgent {
  readonly agentId: string;
  send(message: string | SDKUserMessage): Promise<CursorSdkRun>;
  close(): void;
}

export interface CursorSdkInProcessDependencies {
  createAgent(options: AgentOptions): Promise<CursorSdkAgent>;
  deleteAgent(agentId: string): Promise<void>;
}

export interface CursorSdkInProcessInput {
  readonly apiKey: string;
  readonly model: string;
  readonly agentName: string;
  readonly prompt: string;
  readonly workingDirectory?: string;
  readonly clientTools: readonly CursorClientToolSpec[];
  readonly images?: readonly AgentImageInput[];
  readonly signal?: AbortSignal;
}

interface CursorSdkAgentResources {
  start(this: void): Promise<{ agent: CursorSdkAgent; run: CursorSdkRun }>;
  cleanup(this: void): Promise<void>;
}

const defaultDependencies: CursorSdkInProcessDependencies = {
  createAgent: createIsolatedAgent,
  deleteAgent: deleteIsolatedAgent,
};

const agentWorkspaces = new Map<string, string>();

export async function createCursorSdkInProcessCompletion(
  input: CursorSdkInProcessInput,
  dependencies: CursorSdkInProcessDependencies = defaultDependencies,
): Promise<CursorSdkCompletion> {
  input.signal?.throwIfAborted();
  const handoff = createToolHandoff(input.clientTools);
  const resources = createSdkAgentResources(input, handoff, dependencies);

  try {
    const { agent, run } = await resources.start();
    return {
      agentId: agent.agentId,
      runId: run.id,
      stream: streamSdkRun(run, handoff, input, resources.cleanup),
      cancel: resources.cleanup,
    };
  } catch (error) {
    await resources.cleanup();
    throw error;
  }
}

function createSdkAgentResources(
  input: CursorSdkInProcessInput,
  handoff: ReturnType<typeof createToolHandoff>,
  dependencies: CursorSdkInProcessDependencies,
): CursorSdkAgentResources {
  let agent: CursorSdkAgent | undefined;
  let run: CursorSdkRun | undefined;
  let agentClosed = false;
  let cleanupPromise: Promise<void> | undefined;
  const closeAgent = (): void => {
    if (agent === undefined || agentClosed) return;
    agentClosed = true;
    agent.close();
  };
  const cleanup = function cleanupAgentRun(): Promise<void> {
    if (cleanupPromise === undefined) {
      if (abortHandler !== undefined) {
        input.signal?.removeEventListener("abort", abortHandler);
      }
      cleanupPromise = disposeAgentRun(agent, run, handoff, dependencies, closeAgent);
    }
    return cleanupPromise;
  };
  const abortHandler = (): void => {
    if (run !== undefined) {
      void cleanup().catch(() => undefined);
      return;
    }
    closeAgent();
  };
  input.signal?.addEventListener("abort", abortHandler, { once: true });

  const start = async (): Promise<{ agent: CursorSdkAgent; run: CursorSdkRun }> => {
    agent = await dependencies.createAgent(createAgentOptions(input, handoff.tools));
    input.signal?.throwIfAborted();
    run = await agent.send(createUserMessage(input));
    input.signal?.throwIfAborted();
    return { agent, run };
  };

  return { start, cleanup };
}

function createAgentOptions(
  input: CursorSdkInProcessInput,
  customTools: Record<string, SDKCustomTool>,
): AgentOptions {
  const hasClientTools = Object.keys(customTools).length > 0;
  return {
    apiKey: input.apiKey,
    model: { id: input.model },
    name: input.agentName,
    mode: "agent",
    tools: hasClientTools ? ["mcp"] : [],
    mcpServers: {},
    local: {
      settingSources: [],
      ...(hasClientTools ? { customTools } : {}),
    },
  };
}

async function createIsolatedAgent(options: AgentOptions): Promise<CursorSdkAgent> {
  const workspace = await mkdtemp(join(tmpdir(), "cursor-edge-owned-"));
  try {
    const agent = await Agent.create({
      ...options,
      local: { ...options.local, cwd: workspace },
    });
    agentWorkspaces.set(agent.agentId, workspace);
    return agent;
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

async function deleteIsolatedAgent(agentId: string): Promise<void> {
  const workspace = agentWorkspaces.get(agentId);
  if (workspace === undefined) return;
  agentWorkspaces.delete(agentId);
  try {
    await Agent.delete(agentId, { cwd: workspace });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function disposeAgentRun(
  agent: CursorSdkAgent | undefined,
  run: CursorSdkRun | undefined,
  handoff: ReturnType<typeof createToolHandoff>,
  dependencies: CursorSdkInProcessDependencies,
  closeAgent: () => void,
): Promise<void> {
  handoff.release();
  try {
    if (run?.status === "running") await run.cancel();
  } finally {
    if (agent !== undefined) {
      try {
        closeAgent();
      } finally {
        await dependencies.deleteAgent(agent.agentId);
      }
    }
  }
}

function createUserMessage(input: CursorSdkInProcessInput): SDKUserMessage {
  const workspaceContext = input.workingDirectory
    ? `\n\nIDE workspace for client-side tools only: ${JSON.stringify(input.workingDirectory)}`
    : "";
  const toolPolicy = input.clientTools.length
    ? "\n\nRequest one client tool at a time. Wait for its result in a later request before deciding whether another client tool is needed."
    : "";
  const images: SDKImage[] = (input.images ?? []).map((image) => ({
    data: image.data,
    mimeType: image.mimeType,
  }));
  return {
    text: `${input.prompt}${workspaceContext}${toolPolicy}`,
    ...(images.length > 0 ? { images } : {}),
  };
}

function createToolHandoff(tools: readonly CursorClientToolSpec[]): {
  tools: Record<string, SDKCustomTool>;
  release: () => void;
  hasTool: (name: string) => boolean;
} {
  const pending = new Set<(result: SDKCustomToolResult) => void>();
  const toolNames = new Set<string>();
  let released = false;
  const definitions = tools.map((tool) => {
    const name = tool.name.trim();
    if (!name || toolNames.has(name)) {
      throw invalidClientTool("Client tool names must be non-empty and unique.");
    }
    toolNames.add(name);
    const inputSchema = jsonSchemaRecord(tool.parameters);
    const definition: SDKCustomTool = {
      ...(tool.description ? { description: tool.description } : {}),
      ...(inputSchema ? { inputSchema } : {}),
      execute: () =>
        new Promise<SDKCustomToolResult>((resolve) => {
          if (released) {
            resolve({ forwardedToClient: true });
            return;
          }
          pending.add(resolve);
        }),
    };
    return [name, definition] as const;
  });

  return {
    tools: Object.fromEntries(definitions),
    hasTool: (name) => toolNames.has(name),
    release: () => {
      released = true;
      for (const resolve of pending) resolve({ forwardedToClient: true });
      pending.clear();
    },
  };
}

async function* streamSdkRun(
  run: CursorSdkRun,
  handoff: ReturnType<typeof createToolHandoff>,
  input: CursorSdkInProcessInput,
  cleanup: () => Promise<void>,
): AsyncGenerator<CursorTextEvent> {
  let finalText = "";

  try {
    for await (const message of run.stream()) {
      if (input.signal?.aborted) return;
      const text = assistantText(message);
      if (text) {
        finalText += text;
        yield { type: "text", text };
      }
      const toolCalls = clientToolCallsFromMessage(message, handoff);
      if (toolCalls.length > 0) {
        await cleanup();
        yield* forwardedToolCallEvents(toolCalls, finalText);
        return;
      }
    }

    yield* completedSdkRunEvents(run, finalText, cleanup);
  } finally {
    handoff.release();
    await cleanup();
  }
}

function clientToolCallsFromMessage(
  message: SDKMessage,
  handoff: ReturnType<typeof createToolHandoff>,
): CursorToolCall[] {
  if (message.type === "assistant") {
    return clientToolCallsFromAssistantMessage(message, handoff);
  }
  if (message.type !== "tool_call" || message.status !== "running") return [];
  return [clientToolCallFromMessage(message, handoff)];
}

function* forwardedToolCallEvents(
  toolCalls: CursorToolCall[],
  finalText: string,
): Generator<CursorTextEvent> {
  for (const toolCall of toolCalls) yield { type: "tool_call", toolCall };
  yield { type: "done", finalText, toolCalls };
}

async function* completedSdkRunEvents(
  run: CursorSdkRun,
  finalText: string,
  cleanup: () => Promise<void>,
): AsyncGenerator<CursorTextEvent> {
  const result = await run.wait();
  if (result.status !== "finished") {
    throw new Error(
      result.error?.message ?? `Cursor SDK run ended with ${result.status}.`,
    );
  }
  await cleanup();
  yield { type: "done", finalText, toolCalls: [] };
}

function assistantText(message: SDKMessage): string {
  if (message.type !== "assistant") return "";
  return message.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

function clientToolCallFromMessage(
  message: Extract<SDKMessage, { type: "tool_call" }>,
  handoff: ReturnType<typeof createToolHandoff>,
): CursorToolCall {
  return clientToolCallFromMcp(message.name, message.args, handoff);
}

function clientToolCallsFromAssistantMessage(
  message: SDKMessage,
  handoff: ReturnType<typeof createToolHandoff>,
): CursorToolCall[] {
  if (message.type !== "assistant") return [];
  return message.message.content.flatMap((block) =>
    block.type === "tool_use"
      ? [clientToolCallFromMcp(block.name, block.input, handoff)]
      : [],
  );
}

function clientToolCallFromMcp(
  name: string,
  argsValue: unknown,
  handoff: ReturnType<typeof createToolHandoff>,
): CursorToolCall {
  if (name !== "mcp" || !isRecord(argsValue)) {
    throw invalidClientTool(
      "Cursor SDK requested a tool outside the client tool inventory.",
    );
  }
  const providerIdentifier = argsValue.providerIdentifier;
  const toolName = argsValue.toolName;
  const args = argsValue.args;
  if (
    providerIdentifier !== "custom-user-tools" ||
    typeof toolName !== "string" ||
    !handoff.hasTool(toolName) ||
    !isRecord(args)
  ) {
    throw invalidClientTool(
      "Cursor SDK requested a tool outside the client tool inventory.",
    );
  }
  return { name: toolName, arguments: args };
}

function jsonSchemaRecord(value: unknown): Record<string, SDKJsonValue> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw invalidClientTool("Client tool parameters must be a JSON schema object.");
  }
  const entries: Array<[string, SDKJsonValue]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (!isSdkJsonValue(item)) {
      throw invalidClientTool("Client tool parameters must be a JSON schema object.");
    }
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function isSdkJsonValue(value: unknown): value is SDKJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isSdkJsonValue);
  return isRecord(value) && Object.values(value).every(isSdkJsonValue);
}

function invalidClientTool(message: string): CursorProviderError {
  return new CursorProviderError(message, "cursor_invalid_client_tool");
}
