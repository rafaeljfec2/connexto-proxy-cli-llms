import { afterEach, describe, expect, it, vi } from "vitest";
import { warnCursorEdgeOwnedEnvIfNeeded } from "../apps/api/src/utils/cursor-edge-env.js";

describe("warnCursorEdgeOwnedEnvIfNeeded", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not require private backend variables for in-process edge execution", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnCursorEdgeOwnedEnvIfNeeded({
      CURSOR_EXECUTION_MODE: "auto",
      CURSOR_BACKEND_BASE_URL: "",
      CURSOR_LOCAL_AGENT_ENDPOINT: "",
      CURSOR_CHAT_ENDPOINT: "",
    });

    expect(warnSpy).not.toHaveBeenCalled();
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

  it("does not warn in edge mode when private backend variables are absent", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    warnCursorEdgeOwnedEnvIfNeeded({
      CURSOR_EXECUTION_MODE: "edge",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
