import process from "node:process";

/**
 * Warns when local execution is explicitly selected for hub-integrated requests.
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
        hint: "CURSOR_EXECUTION_MODE=local forces local_runtime for AI Hub (X-Gateway-API-Key) and conflicts with Codex edge tool execution. Prefer auto or edge (see docs/configuration.md).",
      }),
    );
  }
}
