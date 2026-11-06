import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp, createLogger, setLogger } from "@agent-runtime-gateway/api";
import { Writable } from "node:stream";

interface CapturedLog {
  readonly level: number | string;
  readonly msg: string;
  readonly body?: unknown;
  readonly query?: unknown;
  readonly [key: string]: unknown;
}

function captureLogs(): { readonly logs: CapturedLog[]; readonly stream: Writable } {
  const logs: CapturedLog[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const entry = JSON.parse(chunk.toString("utf8")) as CapturedLog;
        logs.push(entry);
      } catch {
        // ignore non-json
      }
      callback();
    },
  });
  return { logs, stream };
}

const antigravityAuthBase = "/v1/providers/antigravity/auth";

describe("Antigravity Auth HTTP Routes Suite", () => {
  it("POST .../auth/start starts authentication and returns valid payload", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const res = await request(app).post(`${antigravityAuthBase}/start`).send({});

    expect(res.status).toBe(200);
    expect(res.body.operationId).toBeDefined();
    expect(res.body.status).toBe("pending");
    expect(res.body.state).toBeDefined();
    expect(res.body.authUrl).toContain("https://accounts.google.com/o/oauth2/auth");
    expect(res.body.authUrl).toContain("code_challenge_method=S256");
    expect(res.body.expiresAt).toBeDefined();
  });

  it("GET .../auth/operations/:operationId returns operation or 404 for unknown operation", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const notFoundRes = await request(app)
      .get(`${antigravityAuthBase}/operations/non-existent-op-id`)
      .send();

    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.body.error).toBeDefined();
    expect(notFoundRes.body.error.code).toBe("operation_not_found");

    const startRes = await request(app).post(`${antigravityAuthBase}/start`).send({});

    const foundRes = await request(app)
      .get(`${antigravityAuthBase}/operations/${startRes.body.operationId}`)
      .send();

    expect(foundRes.status).toBe(200);
    expect(foundRes.body.operationId).toBe(startRes.body.operationId);
    expect(foundRes.body.status).toBe("pending");
  });

  it("GET .../auth/callback validates state and handles missing or mismatched state", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const noStateRes = await request(app)
      .get(`${antigravityAuthBase}/callback`)
      .query({ code: "test-code" });

    expect(noStateRes.status).toBe(400);
    expect(noStateRes.body.error.code).toBe("invalid_state");

    const invalidStateRes = await request(app)
      .get(`${antigravityAuthBase}/callback`)
      .query({ state: "unknown-state-token", code: "test-code" });

    expect(invalidStateRes.status).toBe(400);
    expect(invalidStateRes.body.error.code).toBe("invalid_state");
  });

  it("GET .../auth/callback handles authorization denied from Google", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const startRes = await request(app).post(`${antigravityAuthBase}/start`).send({});

    const deniedRes = await request(app).get(`${antigravityAuthBase}/callback`).query({
      state: startRes.body.state,
      error: "access_denied",
      error_description: "User rejected permission request",
    });

    expect(deniedRes.status).toBe(400);
    expect(deniedRes.body.error.code).toBe("authorization_denied");
    expect(deniedRes.body.error.message).toContain("User rejected permission request");

    const opRes = await request(app)
      .get(`${antigravityAuthBase}/operations/${startRes.body.operationId}`)
      .send();

    expect(opRes.status).toBe(200);
    expect(opRes.body.status).toBe("failed");
    expect(opRes.body.error).toContain("User rejected permission request");
  });

  it("GET .../auth/callback completes flow with valid code and state", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const startRes = await request(app).post(`${antigravityAuthBase}/start`).send({});

    const callbackRes = await request(app).get(`${antigravityAuthBase}/callback`).query({
      state: startRes.body.state,
      code: "auth-authorization-code-12345",
    });

    expect(callbackRes.status).toBe(200);
    expect(callbackRes.body.status).toBe("completed");
    expect(callbackRes.body.operationId).toBe(startRes.body.operationId);

    const opRes = await request(app)
      .get(`${antigravityAuthBase}/operations/${startRes.body.operationId}`)
      .send();

    expect(opRes.status).toBe(200);
    expect(opRes.body.status).toBe("completed");
  });

  it("GET .../auth/callback returns user-friendly HTML when requested by a browser", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const startRes = await request(app).post(`${antigravityAuthBase}/start`).send({});

    const htmlRes = await request(app)
      .get(`${antigravityAuthBase}/callback`)
      .set("Accept", "text/html,application/xhtml+xml")
      .query({
        state: startRes.body.state,
        code: "browser-auth-code-12345",
      });

    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers["content-type"]).toContain("text/html");
    expect(htmlRes.text).toContain("Autenticação Concluída!");
    expect(htmlRes.text).toContain("fechar esta janela");
  });

  it("POST .../auth/callback completes flow programmatically via JSON", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const startRes = await request(app).post(`${antigravityAuthBase}/start`).send({});

    const completeRes = await request(app).post(`${antigravityAuthBase}/callback`).send({
      state: startRes.body.state,
      code: "auth-authorization-code-67890",
    });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.status).toBe("completed");
    expect(completeRes.body.operationId).toBe(startRes.body.operationId);
  });

  it("GET .../auth/status returns status with viability gate and without secrets", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const statusRes = await request(app).get(`${antigravityAuthBase}/status`).send();

    expect(statusRes.status).toBe(200);
    expect(typeof statusRes.body.authenticated).toBe("boolean");
    expect(statusRes.body.viabilityGate).toBe("PARTIALLY_SUPPORTED");
    expect(Array.isArray(statusRes.body.limitations)).toBe(true);
    expect(statusRes.body.limitations.length).toBeGreaterThan(0);
    expect(statusRes.body).not.toHaveProperty("access_token");
    expect(statusRes.body).not.toHaveProperty("refresh_token");
    expect(statusRes.body).not.toHaveProperty("token");
    expect(statusRes.body).not.toHaveProperty("secret");
  });

  it("redacts authorization codes and secrets in HTTP payload logs", async () => {
    const { logs, stream } = captureLogs();
    const logger = createLogger({ destination: stream, level: "info" });
    setLogger(logger);

    const app = buildApp({
      HOST: "127.0.0.1",
      LOG_HTTP_PAYLOADS: true,
    });

    const startRes = await request(app).post(`${antigravityAuthBase}/start`).send({});

    const secretAuthCode = "SECRET_CODE_VALUE_ABC_999";

    await request(app).get(`${antigravityAuthBase}/callback`).query({
      state: startRes.body.state,
      code: secretAuthCode,
    });

    const rawLogs = logs.map((l) => JSON.stringify(l)).join("\n");
    expect(rawLogs).not.toContain(secretAuthCode);

    // Verify query code was redacted to [REDACTED]
    const callbackLog = logs.find(
      (l) =>
        l.msg === "http payload" &&
        l.direction === "inbound" &&
        l.path === `${antigravityAuthBase}/callback`,
    );
    expect(callbackLog).toBeDefined();
    expect((callbackLog?.query as Record<string, unknown>)?.code).toBe("[REDACTED]");
  });

  it("enforces gateway authentication on Antigravity auth endpoints when configured", async () => {
    const app = buildApp({
      HOST: "127.0.0.1",
      GATEWAY_API_TOKEN: "secret-gateway-token",
    });

    const unauthorizedRes = await request(app)
      .post(`${antigravityAuthBase}/start`)
      .send({});

    expect(unauthorizedRes.status).toBe(401);
    expect(unauthorizedRes.body.error.code).toBe("unauthorized");

    const authorizedRes = await request(app)
      .post(`${antigravityAuthBase}/start`)
      .set("x-gateway-api-key", "secret-gateway-token")
      .send({});

    expect(authorizedRes.status).toBe(200);
    expect(authorizedRes.body.operationId).toBeDefined();
  });

  it("legacy /v1/antigravity/auth/* aliases match canonical behavior", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const legacyBase = "/v1/antigravity/auth";

    const start = await request(app).post(`${legacyBase}/start`).send({});
    expect(start.status).toBe(200);

    const op = await request(app).get(
      `${legacyBase}/operations/${String(start.body.operationId)}`,
    );
    expect(op.status).toBe(200);
    expect(op.body.operationId).toBe(start.body.operationId);
  });

  it("preserves existing routes without regression (/health and /v1/models)", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const healthRes = await request(app).get("/health");
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe("ok");

    const modelsRes = await request(app).get("/v1/models");
    expect(modelsRes.status).toBe(200);
    expect(modelsRes.body.object).toBe("list");
  });
});
