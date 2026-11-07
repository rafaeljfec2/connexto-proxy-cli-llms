import { describe, expect, it } from "vitest";
import {
  resolveCursorExecutionMode,
  resolveCursorExecutionModeForRequest,
} from "../apps/api/src/utils/cursor-execution-mode.js";

describe("resolveCursorExecutionMode", () => {
  it("defaults hub-integrated requests to edge_owned when setting is auto", () => {
    expect(
      resolveCursorExecutionMode({ hubIntegrated: true, setting: "auto" }),
    ).toBe("edge_owned");
  });

  it("keeps direct clients on local_runtime when setting is auto", () => {
    expect(
      resolveCursorExecutionMode({ hubIntegrated: false, setting: "auto" }),
    ).toBe("local_runtime");
  });

  it("honors explicit edge and local overrides", () => {
    expect(
      resolveCursorExecutionMode({ hubIntegrated: false, setting: "edge" }),
    ).toBe("edge_owned");
    expect(
      resolveCursorExecutionMode({ hubIntegrated: true, setting: "local" }),
    ).toBe("local_runtime");
  });

  it("reads X-Gateway-API-Key from the request", () => {
    const req = {
      get: (name: string) => (name === "x-gateway-api-key" ? "hub" : undefined),
    } as Parameters<typeof resolveCursorExecutionModeForRequest>[0];
    expect(resolveCursorExecutionModeForRequest(req, "auto")).toBe("edge_owned");
  });
});
