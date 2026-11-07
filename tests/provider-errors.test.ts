import request from "supertest";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildApp,
  createLogger,
  getLogger,
  setLogger,
} from "@agent-runtime-gateway/api";
import { HttpError } from "@agent-runtime-gateway/compatibility-openai";
import { CursorProviderError } from "@agent-runtime-gateway/provider-cursor";
import { getGatewayServices } from "../apps/api/src/services/gateway.js";
import { createStubProvider } from "../packages/core/tests/helpers/stub-provider.js";
import type { AgentProvider, AgentRun } from "../packages/core/src/index.js";

interface RegistryAccess {
  readonly router: {
    readonly registry: {
      readonly providers: Map<string, AgentProvider>;
    };
  };
}

interface LogRecord {
  readonly requestId?: string;
  readonly method?: string;
  readonly route?: string;
  readonly status?: number;
  readonly durationMs?: number;
  readonly msg?: string;
  readonly [key: string]: unknown;
}

const config = { HOST: "127.0.0.1", GATEWAY_API_TOKEN: undefined };
const app = buildApp(config);
const registry = (getGatewayServices().executor as unknown as RegistryAccess).router
  .registry.providers;
const originalProvider = registry.get("cursor");
const sensitiveUpstreamMessage =
  "token=UPSTREAM_TOKEN_73f1 /home/runner/private/provider.ts";

function installFailingProvider(failure: Error): void {
  registry.set(
    "cursor",
    createStubProvider("cursor", {
      execute: () => Promise.reject(failure),
    }),
  );
}

function installFailedRun(message: string): void {
  registry.set(
    "cursor",
    createStubProvider("cursor", {
      execute: (input): Promise<AgentRun> => {
        async function* events(): AsyncGenerator<never> {}
        return Promise.resolve({
          id: `run_${input.sessionId}`,
          events: events(),
          wait: () => Promise.resolve({ status: "failed", error: { message } }),
          cancel: () => Promise.resolve(undefined),
        });
      },
    }),
  );
}

function installCancelledRun(): void {
  registry.set(
    "cursor",
    createStubProvider("cursor", {
      execute: (input): Promise<AgentRun> => {
        async function* events(): AsyncGenerator<never> {}
        return Promise.resolve({
          id: `run_${input.sessionId}`,
          events: events(),
          wait: () => Promise.resolve({ status: "cancelled" }),
          cancel: () => Promise.resolve(undefined),
        });
      },
    }),
  );
}

beforeAll(() => {
  if (!originalProvider) throw new Error("Cursor provider is not registered");
});

afterAll(() => {
  if (originalProvider) registry.set("cursor", originalProvider);
});

describe("Provider HTTP errors", () => {
  it("sanitizes unexpected provider messages, tokens, and local paths", async () => {
    installFailingProvider(new Error(sensitiveUpstreamMessage));
    const previousLogger = getLogger();
    const logLines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(chunk.toString("utf8"));
        callback();
      },
    });
    setLogger(createLogger({ destination, level: "info" }));
    let responseRequestId: string | undefined;

    try {
      const response = await request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer synthetic-cursor-key")
        .send({ model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] });

      expect(response.status).toBe(500);
      expect(response.body.error.type).toBe("internal_error");
      expect(response.headers["x-request-id"]).toBeDefined();
      responseRequestId = response.headers["x-request-id"];
      expect(response.text).not.toContain("UPSTREAM_TOKEN_73f1");
      expect(response.text).not.toContain("/home/runner/private");
      expect(response.text).not.toContain("provider.ts");
    } finally {
      setLogger(previousLogger);
    }

    const records = logLines.map((line) => JSON.parse(line) as LogRecord);
    const summary = records.find((record) => record.msg === "request completed");
    expect(summary?.requestId).toBeDefined();
    expect(summary?.requestId).toBe(responseRequestId);
    expect(summary?.method).toBe("POST");
    expect(summary?.route).toBe("/v1/chat/completions");
    expect(summary?.status).toBe(500);
    expect(typeof summary?.durationMs).toBe("number");
    expect(logLines.join("\n")).not.toContain("UPSTREAM_TOKEN_73f1");
    expect(logLines.join("\n")).not.toContain("/home/runner/private");
  });

  it("maps known Cursor rate limits to a public rate-limit response", async () => {
    installFailingProvider(
      new CursorProviderError(sensitiveUpstreamMessage, "cursor_rate_limit", {
        retryable: true,
      }),
    );
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer synthetic-cursor-key")
      .send({ model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] });

    expect(response.status).toBe(429);
    expect(response.body.error.type).toBe("rate_limit_error");
    expect(response.text).not.toContain("UPSTREAM_TOKEN_73f1");
  });

  it("preserves cursor_missing_backend_url from HttpError instead of internal_error", async () => {
    installFailingProvider(
      new HttpError("Cursor backend URL is not configured", 500, "cursor_missing_backend_url"),
    );
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer synthetic-cursor-key")
      .send({ model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("cursor_missing_backend_url");
    expect(response.body.error.message).toContain("not configured");
    expect(response.body.error.type).not.toBe("internal_error");
  });

  it("maps Cursor credential failures to upstream errors, not gateway authorization errors", async () => {
    installFailingProvider(
      new CursorProviderError(sensitiveUpstreamMessage, "cursor_authentication_error"),
    );
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer synthetic-cursor-key")
      .send({ model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] });

    expect(response.status).toBe(502);
    expect(response.body.error.type).toBe("upstream_error");
    expect(response.text).not.toContain("UPSTREAM_TOKEN_73f1");
  });

  it("does not expose failed-run messages in the upstream error response", async () => {
    installFailedRun(sensitiveUpstreamMessage);
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer synthetic-cursor-key")
      .send({ model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] });

    expect(response.status).toBe(502);
    expect(response.body.error.type).toBe("upstream_error");
    expect(response.text).not.toContain("UPSTREAM_TOKEN_73f1");
    expect(response.text).not.toContain("/home/runner/private");
  });

  it("finishes provider-cancelled responses without an HTTP disconnect", async () => {
    installCancelledRun();
    const requests = [
      {
        path: "/v1/chat/completions",
        body: { model: "composer-2.5", messages: [{ role: "user", content: "Hi" }] },
      },
      {
        path: "/v1/responses/compact",
        body: { model: "composer-2.5", input: "Hi" },
      },
    ];

    for (const pendingRequest of requests) {
      const response = await request(app)
        .post(pendingRequest.path)
        .set("Authorization", "Bearer synthetic-cursor-key")
        .send(pendingRequest.body);

      expect(response.status).toBe(502);
      expect(response.body.error.type).toBe("upstream_error");
    }
  });

  it("does not attempt a success response after a failed compaction run", async () => {
    installFailedRun(sensitiveUpstreamMessage);
    const previousLogger = getLogger();
    const logLines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(chunk.toString("utf8"));
        callback();
      },
    });
    setLogger(createLogger({ destination, level: "info" }));

    let responseStatus: number | undefined;
    let responseText = "";
    try {
      const response = await request(app)
        .post("/v1/responses/compact")
        .set("Authorization", "Bearer synthetic-cursor-key")
        .send({ model: "composer-2.5", input: "Sensitive context" });
      responseStatus = response.status;
      responseText = response.text;
      expect(response.body.error.type).toBe("upstream_error");
    } finally {
      setLogger(previousLogger);
    }

    const records = logLines.map((line) => JSON.parse(line) as LogRecord);
    const summary = records.find((record) => record.msg === "request completed");
    expect(responseStatus).toBe(502);
    expect(responseText).not.toContain("UPSTREAM_TOKEN_73f1");
    expect(responseText).not.toContain("/home/runner/private");
    expect(summary?.status).toBe(502);
  });
});
