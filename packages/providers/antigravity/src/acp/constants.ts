export const ACP_PROTOCOL_VERSION = 1;

export const JSON_RPC_ERROR_AUTH_REQUIRED = -32000;

export const AGY_CLI_PATH_ENV = "AGY_PATH";
export const DEFAULT_AGY_BINARY = "agy";

const DEFAULT_AGY_FALLBACK_CANDIDATES = [".gemini/bin/agy"] as const;

export function defaultAgyPathCandidates(): readonly string[] {
  const home = process.env["HOME"] ?? "";
  return DEFAULT_AGY_FALLBACK_CANDIDATES.map((relative) => `${home}/${relative}`);
}

export const DEFAULT_AUTH_METHOD_ID = "oauth-personal";

export const DEFAULT_PROMPT_TURN_TIMEOUT_MS = 240_000;

export const DEFAULT_SESSION_TIMEOUT_MS = 60_000;

export const DEFAULT_AUTH_TIMEOUT_MS = 120_000;

export const DEFAULT_INITIALIZE_TIMEOUT_MS = 30_000;

export const DEFAULT_PROCESS_GRACE_MS = 3_000;
