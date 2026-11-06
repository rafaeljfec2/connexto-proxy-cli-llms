import { buildApp } from "@agent-runtime-gateway/api";
import request from "supertest";
import { describe, expect, it } from "vitest";

describe("Swagger / OpenAPI", () => {
  it("serves the OpenAPI document without gateway auth", async () => {
    const app = buildApp({
      HOST: "127.0.0.1",
      GATEWAY_API_TOKEN: "test-gateway-token",
    });

    const response = await request(app).get("/openapi.json");

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe("3.0.3");
    expect(response.body.paths["/health"]).toBeDefined();
    expect(response.body.paths["/v1/chat/completions"]).toBeDefined();
    expect(response.body.paths["/v1/providers/antigravity/auth/start"]).toBeDefined();
    expect(response.body.paths["/v1/runtime/sessions/clear"]).toBeDefined();
    expect(
      response.body.paths["/v1/providers/antigravity/auth/callback"],
    ).toBeDefined();
    expect(response.body.paths["/v1/providers/antigravity/auth/status"]).toBeDefined();
    expect(
      response.body.paths["/v1/providers/antigravity/auth/operations/{operationId}"],
    ).toBeDefined();
    expect(response.body.paths["/v1/providers/antigravity/usage"]).toBeDefined();
    expect(
      response.body.components.schemas.AntigravityAuthStatusResponse,
    ).toBeDefined();
    expect(response.body.components.schemas.AntigravityUsageSnapshot).toBeDefined();
    expect(response.body.servers[0]?.url).toMatch(/^https?:\/\//);
  });

  it("uses the request Host in the OpenAPI servers list", async () => {
    const app = buildApp();

    const response = await request(app)
      .get("/openapi.json")
      .set("Host", "127.0.0.1:3001");

    expect(response.status).toBe(200);
    expect(response.body.servers[0]?.url).toBe("http://127.0.0.1:3001");
  });

  it("serves Swagger UI at /docs", async () => {
    const app = buildApp();

    const response = await request(app).get("/docs/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("swagger-ui");
  });
});
