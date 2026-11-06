import fs from "node:fs";
import path from "node:path";

export interface AgentWorkingDirectoryContext {
  readonly workingDirectory?: string;
}

export function resolveAgentWorkingDirectory(
  configuredDefault: string | undefined,
  toolContext?: AgentWorkingDirectoryContext,
): string | undefined {
  const fromContext = toolContext?.workingDirectory?.trim();
  if (fromContext) {
    return path.resolve(fromContext);
  }
  const trimmedDefault = configuredDefault?.trim();
  if (trimmedDefault) {
    return path.resolve(trimmedDefault);
  }
  return undefined;
}

export function assertConfiguredWorkingDirectoryExists(configuredDefault: string): void {
  const resolved = path.resolve(configuredDefault.trim());
  if (!fs.existsSync(resolved)) {
    throw new Error(`CURSOR_DEFAULT_WORKING_DIRECTORY does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`CURSOR_DEFAULT_WORKING_DIRECTORY is not a directory: ${resolved}`);
  }
}
