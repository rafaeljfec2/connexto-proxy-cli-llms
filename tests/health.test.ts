import { buildApp } from "@agent-runtime-gateway/api";
import { describe, expect, it } from "vitest";

describe("GET /health", () => {
  it("returns ok status", async () => {
    const app = buildApp();

    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);

    const body: { status: string; service: string } = response.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("agent-runtime-gateway");

    await app.close();
  });
});
