import type { Request } from "express";
import { loadEnv } from "../config/env.js";
import {
  resolveAgentWorkingDirectory,
  type AgentWorkingDirectoryContext,
} from "./working-directory.js";

export function isHubIntegratedRequest(req: Request): boolean {
  const header = req.get("x-gateway-api-key")?.trim();
  return header !== undefined && header.length > 0;
}

export function providerRequiresLocalWorkspace(providerId: string): boolean {
  return providerId === "cursor" || providerId === "antigravity";
}

export function getConfiguredDefaultWorkingDirectory(): string | undefined {
  const env = loadEnv();
  const trimmed = env.CURSOR_DEFAULT_WORKING_DIRECTORY?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Hub-integrated clients (AI Hub + Codex) must supply workspace via the agent payload.
 * Direct local clients may fall back to CURSOR_DEFAULT_WORKING_DIRECTORY.
 */
export function resolveExecutionWorkingDirectory(options: {
  hubIntegrated: boolean;
  configuredDefault: string | undefined;
  toolContext?: AgentWorkingDirectoryContext;
}): string | undefined {
  const fromAgent = resolveAgentWorkingDirectory(undefined, options.toolContext);
  if (options.hubIntegrated) {
    return fromAgent;
  }
  return resolveAgentWorkingDirectory(options.configuredDefault, options.toolContext);
}
