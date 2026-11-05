import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "@agent-runtime-gateway/api";
import { Writable } from "node:stream";
import { createLogger, setLogger } from "@agent-runtime-gateway/api";
import { getGatewayServices } from "../apps/api/src/services/gateway.js";
import {
  createCompletedRun,
  createStubProvider,
} from "../packages/core/tests/helpers/stub-provider.js";

interface LogEntry {
  readonly level: number | string;
  readonly msg: string;
  readonly requestId?: string;
  readonly method?: string;
  readonly route?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly timeToFirstDeltaMs?: number;
  readonly errorType?: string;
  readonly errorCode?: string;
  readonly [key: string]: unknown;
}

function createLogCapture(): { readonly logs: LogEntry[]; readonly stream: Writable } {
  const logs: LogEntry[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const parsed = JSON.parse(chunk.toString("utf8")) as LogEntry;
        logs.push(parsed);
      } catch {
        // ignore non-json lines
      }
      callback();
    },
  });
  return { logs, stream };
}

describe("Gateway Logging and Request Correlation", () => {
  beforeAll(() => {
    const services = getGatewayServices();
    const stubCursor = createStubProvider("cursor", {
      execute: (input) =>
        Promise.resolve(
          createCompletedRun("cursor", input.sessionId, "Hello from stub"),
        ),
    });

    const registryHolder = services.executor as unknown as {
      readonly router: {
        readonly registry: {
          readonly providers: Map<string, unknown>;
        };
      };
    };
    registryHolder.router.registry.providers.set("cursor", stubCursor);
  });

  it("generates and attaches X-Request-ID header to every response and exposes it in CORS", async () => {
    const app = buildApp();
    const res = await request(app).get("/health");

    expect(res.status).toBe(200);
    const requestId = res.headers["x-request-id"];
    expect(requestId).toBeDefined();
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    expect(res.headers["access-control-expose-headers"]).toContain("X-Request-ID");
    expect(res.headers["access-control-allow-headers"]).toContain("x-request-id");
  });

  it("always generates a new server-side X-Request-ID ignoring client-provided value", async () => {
    const app = buildApp();
    const clientProvidedId = "client-custom-id-12345";
    const res = await request(app).get("/health").set("X-Request-ID", clientProvidedId);

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).not.toBe(clientProvidedId);
  });

  it("logs structured request summary on completion with normalized route, status, duration and requestId", async () => {
    const { logs, stream } = createLogCapture();
    const logger = createLogger({ destination: stream, level: "info" });
    setLogger(logger);

    const app = buildApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);

    const summaryLog = logs.find(
      (entry) => entry.msg === "request completed" && entry.route === "/health",
    );
    expect(summaryLog).toBeDefined();
    expect(summaryLog?.requestId).toBe(res.headers["x-request-id"]);
    expect(summaryLog?.method).toBe("GET");
    expect(summaryLog?.status).toBe(200);
    expect(typeof summaryLog?.durationMs).toBe("number");
  });

  it("normalizes routes with parameters to prevent data leakage in route paths", async () => {
    const { logs, stream } = createLogCapture();
    const logger = createLogger({ destination: stream, level: "info" });
    setLogger(logger);

    const app = buildApp();
    const res = await request(app).get("/v1/models/composer-2.5?foo=sensitive_value");
    expect(res.status).toBe(200);

    const summaryLog = logs.find(
      (entry) => entry.msg === "request completed" && entry.status === 200,
    );
    expect(summaryLog).toBeDefined();
    expect(summaryLog?.route).toBe("/v1/models/:model");
    // Ensure raw query parameter is NOT in the route
    expect(summaryLog?.route).not.toContain("sensitive_value");
    expect(summaryLog?.route).not.toContain("foo=");
  });

  it("logs provider execution duration and SSE first delta timing without leaking prompts or secrets", async () => {
    const { logs, stream } = createLogCapture();
    const logger = createLogger({ destination: stream, level: "info" });
    setLogger(logger);

    const app = buildApp();
    const secretApiKey = "secret-cursor-api-key-99999";
    const secretPrompt = "Super confidential user prompt text";

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${secretApiKey}`)
      .send({
        model: "composer-2.5",
        messages: [{ role: "user", content: secretPrompt }],
        stream: true,
      });

    expect(res.status).toBe(200);

    // Verify provider execution log or stream completed log
    const providerLog = logs.find(
      (entry) =>
        entry.provider === "cursor" &&
        (entry.msg === "provider stream completed" ||
          entry.msg === "provider execution completed"),
    );
    expect(providerLog).toBeDefined();
    expect(providerLog?.requestId).toBe(res.headers["x-request-id"]);
    expect(typeof providerLog?.durationMs).toBe("number");
    expect(typeof providerLog?.timeToFirstDeltaMs).toBe("number");

    // Negative validation: assert logs never contain secrets, auth tokens, prompts, or response text
    const stringifiedLogs = JSON.stringify(logs);
    expect(stringifiedLogs).not.toContain(secretApiKey);
    expect(stringifiedLogs).not.toContain(secretPrompt);
    expect(stringifiedLogs).not.toContain("Bearer");
  });

  it("logs non-streaming provider execution and request completion", async () => {
    const { logs, stream } = createLogCapture();
    const logger = createLogger({ destination: stream, level: "info" });
    setLogger(logger);

    const app = buildApp();
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer dummy-key")
      .send({
        model: "composer-2.5",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      });

    expect(res.status).toBe(200);

    const providerLog = logs.find(
      (entry) =>
        entry.provider === "cursor" && entry.msg === "provider execution completed",
    );
    expect(providerLog).toBeDefined();
    expect(providerLog?.status).toBe("completed");
    expect(typeof providerLog?.durationMs).toBe("number");
  });
});
