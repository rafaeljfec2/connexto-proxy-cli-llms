import process from "node:process";

const CURSOR_EDGE_BACKEND_VARS = [
  "CURSOR_BACKEND_BASE_URL",
  "CURSOR_LOCAL_AGENT_ENDPOINT",
  "CURSOR_CHAT_ENDPOINT",
] as const;

/**
 * Warns when hub/Codex edge_owned paths are likely to fail for missing Composer
 * backend secrets (same contract as standardagents/composer-api).
 */
export function warnCursorEdgeOwnedEnvIfNeeded(
  source: NodeJS.ProcessEnv = process.env,
): void {
  const mode = (source.CURSOR_EXECUTION_MODE ?? "auto").trim();
  const hubGatewayConfigured = Boolean(source.GATEWAY_API_TOKEN?.trim());
  if (mode === "local" && hubGatewayConfigured) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "cursor_execution_mode_local_with_hub",
        hint:
          "CURSOR_EXECUTION_MODE=local forces local_runtime for AI Hub (X-Gateway-API-Key) and conflicts with Codex edge tool execution. Prefer auto or edge (see docs/configuration.md).",
      }),
    );
  }
  if (mode === "local") return;

  const hasSdkBridge =
    source.CURSOR_SDK_BRIDGE_URL !== undefined &&
    source.CURSOR_SDK_BRIDGE_URL.trim().length > 0;
  if (hasSdkBridge) return;

  const missing = CURSOR_EDGE_BACKEND_VARS.filter(
    (name) => !source[name]?.trim(),
  );
  if (missing.length === 0) return;

  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "cursor_edge_owned_env_incomplete",
      missing,
      hint: "Hub edge_owned inference requires CURSOR_BACKEND_BASE_URL, CURSOR_LOCAL_AGENT_ENDPOINT, and CURSOR_CHAT_ENDPOINT (see docs/configuration.md).",
    }),
  );
}
