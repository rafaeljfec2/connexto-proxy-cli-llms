import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "@agent-runtime-gateway/api";
import { AntigravityProvider } from "@agent-runtime-gateway/provider-antigravity";
import { CursorProvider } from "@agent-runtime-gateway/provider-cursor";
import {
  getGatewayServices,
  initializeGatewayServices,
  resetGatewayServicesForTest,
} from "../apps/api/src/services/gateway.js";

describe("runtime session maintenance", () => {
  beforeEach(() => {
    resetGatewayServicesForTest();
    initializeGatewayServices({ HOST: "127.0.0.1", SESSION_STORAGE_DRIVER: "memory" });
  });

  it("POST /v1/runtime/sessions/clear removes a namespace from the session store", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const { sessionStore } = getGatewayServices();
    await sessionStore.set("cursor", "test-key", { id: "test-key" });

    const res = await request(app)
      .post("/v1/runtime/sessions/clear")
      .send({ namespace: "cursor" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ cleared: true, namespace: "cursor" });
    expect(await sessionStore.exists("cursor", "test-key")).toBe(false);
  });

  it("rejects invalid namespace", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const res = await request(app)
      .post("/v1/runtime/sessions/clear")
      .send({ namespace: "../etc" });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("invalid_namespace");
  });

  it("clears Cursor in-memory session cache after clearing cursor namespace", async () => {
    const clearSpy = vi.spyOn(CursorProvider.prototype, "clearSessionCaches");

    resetGatewayServicesForTest();
    initializeGatewayServices({
      HOST: "127.0.0.1",
      SESSION_STORAGE_DRIVER: "memory",
    });

    const app = buildApp({ HOST: "127.0.0.1" });
    const res = await request(app)
      .post("/v1/runtime/sessions/clear")
      .send({ namespace: "cursor" });

    expect(res.status).toBe(200);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    clearSpy.mockRestore();
  });

  it("closes Antigravity ACP sessions then clears in-memory cache for antigravity namespace", async () => {
    const closeSpy = vi
      .spyOn(AntigravityProvider.prototype, "closePersistedAcpSessions")
      .mockResolvedValue({
        mapped_acp_ids_count: 0,
        listed_acp_sessions_count: 2,
        acp_sessions_closed: 2,
        acp_close_failures: 0,
        warnings: [],
      });
    const clearSpy = vi.spyOn(AntigravityProvider.prototype, "clearSessionCaches");

    resetGatewayServicesForTest();
    initializeGatewayServices({
      HOST: "127.0.0.1",
      SESSION_STORAGE_DRIVER: "memory",
    });

    const app = buildApp({ HOST: "127.0.0.1" });
    const res = await request(app)
      .post("/v1/runtime/sessions/clear")
      .send({ namespace: "antigravity" });

    expect(res.status).toBe(200);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy.mock.invocationCallOrder[0]).toBeLessThan(
      clearSpy.mock.invocationCallOrder[0]!,
    );
    expect(res.body).toMatchObject({
      cleared: true,
      namespace: "antigravity",
      mapped_acp_ids_count: 0,
      listed_acp_sessions_count: 2,
      acp_sessions_closed: 2,
      acp_close_failures: 0,
      warnings: [],
    });
    closeSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
