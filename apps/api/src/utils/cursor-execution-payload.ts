import type { Request } from "express";
import type {
  CursorClientToolSpec,
  CursorExecutionContext,
} from "@agent-runtime-gateway/core";
import type { PreparedRequest } from "@agent-runtime-gateway/compatibility-openai";
import {
  resolveCursorExecutionModeForRequest,
  type CursorExecutionMode,
} from "./cursor-execution-mode.js";

export function mapClientTools(
  tools: PreparedRequest["tools"],
): CursorClientToolSpec[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
  }));
}

export function buildCursorExecutionContext(
  req: Request,
  prepared: PreparedRequest,
): CursorExecutionContext | undefined {
  const mode: CursorExecutionMode = resolveCursorExecutionModeForRequest(req);
  return {
    mode,
    promptMode: prepared.prompt.mode ?? "ask",
    clientTools: mapClientTools(prepared.tools),
    // Edge-owned runs delegate tool execution to the hub client (Codex), not proxy disk.
    requiresLocalTool:
      mode === "edge_owned" ? false : prepared.requiresLocalTool,
  };
}
