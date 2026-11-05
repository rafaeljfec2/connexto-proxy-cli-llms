import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp, loadEnv } from "@agent-runtime-gateway/api";

const localOrigin = "http://localhost:5173";
const remoteOrigin = "https://console.example.com";
const gatewayToken = "synthetic-cors-gateway-token";

function createApp(options: {
  readonly host?: string;
  readonly gatewayToken?: string;
  readonly corsOrigins?: string;
  readonly corsOriginsConfigured?: boolean;
}) {
  const env = loadEnv({
    HOST: options.host ?? "127.0.0.1",
    ...(options.gatewayToken === undefined
      ? {}
      : { GATEWAY_API_TOKEN: options.gatewayToken }),
    ...(options.corsOriginsConfigured === true
      ? { CORS_ORIGINS: options.corsOrigins ?? "" }
      : {}),
  });

  return buildApp(env);
}

function setAllowedPostPreflight(
  requestBuilder: request.Test,
  origin: string,
): request.Test {
  return requestBuilder
    .set("Origin", origin)
    .set("Access-Control-Request-Method", "POST")
    .set(
      "Access-Control-Request-Headers",
      "authorization,content-type,x-gateway-api-key",
    );
}

describe("CORS policy", () => {
  it.each(["http://localhost:5173", "http://127.0.0.2:4173", "https://[::1]:5173"])(
    "allows local loopback origin %s by default",
    async (origin) => {
      const response = await request(createApp({}))
        .get("/health")
        .set("Origin", origin);

      expect(response.status).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers.vary).toContain("Origin");
      expect(response.headers["access-control-expose-headers"]).toContain(
        "X-Request-ID",
      );
    },
  );

  it("allows only a remote origin explicitly configured in CORS_ORIGINS", async () => {
    const app = createApp({
      host: "0.0.0.0",
      gatewayToken,
      corsOrigins: remoteOrigin,
      corsOriginsConfigured: true,
    });
    const response = await request(app).get("/health").set("Origin", remoteOrigin);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(remoteOrigin);
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("allows each origin in a configured list without reflecting unknown origins", async () => {
    const app = createApp({
      host: "0.0.0.0",
      gatewayToken,
      corsOrigins: `${remoteOrigin},https://admin.example.com`,
      corsOriginsConfigured: true,
    });
    const allowed = await request(app)
      .get("/health")
      .set("Origin", "https://admin.example.com");
    const unknown = await request(app)
      .get("/health")
      .set("Origin", "https://attacker.example");

    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://admin.example.com",
    );
    expect(unknown.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it.each([
    "https://unknown.example",
    "http://localhost.attacker.example",
    "null",
    "http://localhost/path",
  ])("does not authorize unknown or malformed origin %s", async (origin) => {
    const response = await request(createApp({})).get("/health").set("Origin", origin);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers.vary).toContain("Origin");
  });

  it("returns no CORS authorization when the Origin header is absent", async () => {
    const response = await request(createApp({})).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers.vary).toContain("Origin");
  });

  it("keeps origin-less OPTIONS at 204 without CORS authorization", async () => {
    const response = await request(createApp({})).options("/v1/chat/completions");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers.vary).toContain("Origin");
    expect(response.headers.vary).toContain("Access-Control-Request-Method");
    expect(response.headers.vary).toContain("Access-Control-Request-Headers");
  });

  it("disables the implicit local-origin policy when an empty list is explicit", async () => {
    const response = await request(
      createApp({ corsOriginsConfigured: true, corsOrigins: "" }),
    )
      .get("/health")
      .set("Origin", localOrigin);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("does not authorize origins by default on a remote bind", async () => {
    const response = await request(createApp({ host: "0.0.0.0", gatewayToken }))
      .get("/health")
      .set("Origin", remoteOrigin);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows a configured preflight with required method and headers", async () => {
    const app = createApp({
      host: "0.0.0.0",
      gatewayToken,
      corsOrigins: remoteOrigin,
      corsOriginsConfigured: true,
    });
    const response = await setAllowedPostPreflight(
      request(app).options("/v1/chat/completions"),
      remoteOrigin,
    );

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(remoteOrigin);
    expect(response.headers["access-control-allow-methods"]).toBe("POST");
    expect(response.headers["access-control-allow-headers"]).toBe(
      "authorization,content-type,x-gateway-api-key",
    );
    expect(response.headers["access-control-allow-headers"]).not.toContain(
      "x-request-id",
    );
    expect(response.headers["access-control-expose-headers"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("rejects a preflight from an unconfigured origin without CORS headers", async () => {
    const app = createApp({
      host: "0.0.0.0",
      gatewayToken,
      corsOrigins: remoteOrigin,
      corsOriginsConfigured: true,
    });
    const response = await setAllowedPostPreflight(
      request(app).options("/v1/chat/completions"),
      "https://attacker.example",
    );

    expect(response.status).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-methods"]).toBeUndefined();
    expect(response.headers["access-control-allow-headers"]).toBeUndefined();
  });

  it.each([
    { method: "PUT", headers: "x-gateway-api-key" },
    { method: "POST", headers: "x-unknown-header" },
  ])(
    "rejects a preflight with unsupported method or headers",
    async (requestHeaders) => {
      const app = createApp({
        host: "0.0.0.0",
        gatewayToken,
        corsOrigins: remoteOrigin,
        corsOriginsConfigured: true,
      });
      const response = await request(app)
        .options("/v1/chat/completions")
        .set("Origin", remoteOrigin)
        .set("Access-Control-Request-Method", requestHeaders.method)
        .set("Access-Control-Request-Headers", requestHeaders.headers);

      expect(response.status).toBe(403);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    },
  );

  it("keeps gateway authentication independent from CORS", async () => {
    const app = createApp({
      host: "0.0.0.0",
      gatewayToken,
      corsOrigins: remoteOrigin,
      corsOriginsConfigured: true,
    });
    const response = await request(app)
      .post("/v1/responses/input_tokens")
      .set("Origin", remoteOrigin)
      .send({ input: "synthetic test payload" });

    expect(response.status).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBe(remoteOrigin);
    expect(response.body.error.message).toBe("Missing or invalid gateway API key");
  });

  it("keeps origin-less private requests subject to gateway authentication", async () => {
    const app = createApp({
      host: "0.0.0.0",
      gatewayToken,
      corsOrigins: remoteOrigin,
      corsOriginsConfigured: true,
    });
    const response = await request(app)
      .post("/v1/responses/input_tokens")
      .send({ input: "synthetic test payload" });

    expect(response.status).toBe(401);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.body.error.message).toBe("Missing or invalid gateway API key");
  });
});
