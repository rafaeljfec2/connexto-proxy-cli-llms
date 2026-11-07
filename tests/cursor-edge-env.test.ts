import { afterEach, describe, expect, it, vi } from "vitest";
import { warnCursorEdgeOwnedEnvIfNeeded } from "../apps/api/src/utils/cursor-edge-env.js";

describe("warnCursorEdgeOwnedEnvIfNeeded", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("warns when edge_owned backend variables are missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnCursorEdgeOwnedEnvIfNeeded({
      CURSOR_EXECUTION_MODE: "auto",
      CURSOR_BACKEND_BASE_URL: "",
      CURSOR_LOCAL_AGENT_ENDPOINT: "",
      CURSOR_CHAT_ENDPOINT: "",
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as {
      msg: string;
      missing: string[];
    };
    expect(payload.msg).toBe("cursor_edge_owned_env_incomplete");
    expect(payload.missing).toEqual([
      "CURSOR_BACKEND_BASE_URL",
      "CURSOR_LOCAL_AGENT_ENDPOINT",
      "CURSOR_CHAT_ENDPOINT",
    ]);
  });

  it("warns when CURSOR_EXECUTION_MODE is local with hub gateway configured", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnCursorEdgeOwnedEnvIfNeeded({
      CURSOR_EXECUTION_MODE: "local",
      GATEWAY_API_TOKEN: "hub-token",
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as { msg: string };
    expect(payload.msg).toBe("cursor_execution_mode_local_with_hub");
  });

  it("does not warn edge_owned vars when SDK bridge URL is set", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnCursorEdgeOwnedEnvIfNeeded({
      CURSOR_EXECUTION_MODE: "auto",
      CURSOR_SDK_BRIDGE_URL: "http://127.0.0.1:8792/sdk",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
