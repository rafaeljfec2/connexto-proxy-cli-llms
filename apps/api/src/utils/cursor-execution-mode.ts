import type { Request } from "express";
import { loadEnv } from "../config/env.js";
import { isHubIntegratedRequest } from "./execution-working-directory.js";

export type CursorExecutionMode = "edge_owned" | "local_runtime";

export type CursorExecutionModeSetting = "auto" | "edge" | "local";

let configuredSetting: CursorExecutionModeSetting | undefined;

/** Wired from `buildApp` so per-app env overrides apply outside `process.env`. */
export function configureCursorExecutionMode(
  setting: CursorExecutionModeSetting,
): void {
  configuredSetting = setting;
}

export function resetCursorExecutionModeForTest(): void {
  configuredSetting = undefined;
}

export function getCursorExecutionModeSetting(): CursorExecutionModeSetting {
  if (configuredSetting !== undefined) return configuredSetting;
  const raw = loadEnv().CURSOR_EXECUTION_MODE;
  if (raw === "edge" || raw === "local") return raw;
  return "auto";
}

/**
 * Resolves whether hub-integrated requests should use remote Composer inference
 * (edge-owned tools on the client) or local SDK agents on the proxy disk.
 */
export function resolveCursorExecutionMode(options: {
  hubIntegrated: boolean;
  setting?: CursorExecutionModeSetting;
}): CursorExecutionMode {
  const setting = options.setting ?? getCursorExecutionModeSetting();
  if (setting === "local") return "local_runtime";
  if (setting === "edge") return "edge_owned";
  return options.hubIntegrated ? "edge_owned" : "local_runtime";
}

export function resolveCursorExecutionModeForRequest(
  req: Request,
  setting?: CursorExecutionModeSetting,
): CursorExecutionMode {
  return resolveCursorExecutionMode({
    hubIntegrated: isHubIntegratedRequest(req),
    setting,
  });
}
