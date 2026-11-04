import { buildApp } from "@agent-runtime-gateway/api";
import request from "supertest";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("returns ok status", async () => {
    const app = buildApp();

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "agent-runtime-gateway",
    });
  });
});
