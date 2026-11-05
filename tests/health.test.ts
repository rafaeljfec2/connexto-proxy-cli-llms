import { buildApp } from "@agent-runtime-gateway/api";
import request from "supertest";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("returns ok status with runtime metrics", async () => {
    const app = buildApp();

    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body.status).toBe("ok");
    expect(response.body.service).toBe("agent-runtime-gateway");
    expect(response.body.runtime.responses).toMatchObject({
      stored: expect.any(Number),
      maxEntries: expect.any(Number),
      ttlMs: expect.any(Number),
    });
    expect(response.body.runtime.memory).toMatchObject({
      rss: expect.any(Number),
      heapUsed: expect.any(Number),
    });
  });
});
