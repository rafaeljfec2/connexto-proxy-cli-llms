import type { CursorPrompt } from "../types.js";

export type ApiKind = "chat" | "responses";

export interface PreparedRequest {
  model: string;
  cursorModel?: { id: string };
  prompt: CursorPrompt;
  stream: boolean;
  includeUsage: boolean;
  promptChars: number;
  responseMetadata: Record<string, unknown>;
  tools: OpenAiToolSpec[];
  requiresLocalTool: boolean;
  previousResponseId?: string;
  storeResponse?: boolean;
  responseInputItems?: unknown[];
  toolContext?: ToolCallContext;
}

export interface OpenAiToolSpec {
  name: string;
  description?: string;
  parameters?: unknown;
}

export interface ToolCallContext {
  workingDirectory?: string;
}

export interface OpenAiToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolParameterSchemaShape {
  properties: string[];
  required: string[];
  allowAdditionalProperties: boolean;
  propertySchemas: Record<string, unknown>;
}

export interface CursorModelPricing {
  input: number;
  output: number;
  source: string;
}

export interface SdkToolCallMemory {
  name: string;
  args: Record<string, unknown>;
}
