import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "@agent-runtime-gateway/api";
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
});
