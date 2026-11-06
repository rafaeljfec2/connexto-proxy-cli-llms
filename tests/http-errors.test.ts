import { createRequire } from "node:module";
import { Writable } from "node:stream";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildApp,
  createLogger,
  getLogger,
  setLogger,
} from "@agent-runtime-gateway/api";
import { HttpError } from "@agent-runtime-gateway/compatibility-openai";

interface TestResponse {
  setHeader(name: string, value: string): void;
  write(chunk: string): boolean;
}

interface TestNext {
  (error?: unknown): void;
}

type TestHandler = (
  request: unknown,
  response: TestResponse,
  next: TestNext,
) => void | Promise<void>;

interface TestExpressApp {
  get(path: string, ...handlers: TestHandler[]): void;
  post(path: string, ...handlers: TestHandler[]): void;
  use(...handlers: ReadonlyArray<unknown>): void;
}

interface LogRecord {
  readonly requestId?: string;
  readonly status?: number;
  readonly route?: string;
  readonly durationMs?: number;
  readonly msg?: string;
}

type TestExpressFactory = () => TestExpressApp;

const express = createRequire(new URL("../apps/api/package.json", import.meta.url))(
  "express",
) as TestExpressFactory;

function testRequest(app: TestExpressApp) {
  return request(app as unknown as Parameters<typeof request>[0]);
}

const syntheticBody = "PARSER_BODY_SECRET_83f2";
const config = { HOST: "127.0.0.1", GATEWAY_API_TOKEN: undefined };

describe("HTTP error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a safe OpenAI error for malformed JSON without logging its body or stack", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = buildApp(config);
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
        .set("Content-Type", "application/json")
        .send(`{"secret":"${syntheticBody}"`);

      expect(response.status).toBe(400);
      expect(response.headers["x-request-id"]).toBeDefined();
      responseRequestId = response.headers["x-request-id"];
      expect(response.body.error.type).toBe("invalid_request_error");
      expect(response.text).not.toContain(syntheticBody);
      expect(response.text).not.toContain("SyntaxError");
      expect(response.text).not.toContain("node_modules");
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      setLogger(previousLogger);
    }

    const records = logLines.map((line) => JSON.parse(line) as LogRecord);
    const summary = records.find((record) => record.msg === "request completed");
    expect(summary?.requestId).toBe(responseRequestId);
    expect(summary?.status).toBe(400);
    expect(summary?.route).toBe("/v1/chat/completions");
    expect(typeof summary?.durationMs).toBe("number");
    expect(logLines.join("\n")).not.toContain(syntheticBody);
    expect(logLines.join("\n")).not.toContain("SyntaxError");
  });

  it("returns an OpenAI error for an oversized JSON payload without exposing the body", async () => {
    const app = buildApp({ ...config, GATEWAY_JSON_BODY_LIMIT_BYTES: 100_000 });
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ secret: syntheticBody, padding: "x".repeat(110_000) }));

    expect(response.status).toBe(413);
    expect(response.body.error.type).toBe("invalid_request_error");
    expect(response.text).not.toContain(syntheticBody);
    expect(response.text).not.toContain("PayloadTooLargeError");
  });

  it("keeps incompatible content types on the existing safe request-error contract", async () => {
    const app = buildApp(config);
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Content-Type", "text/plain")
      .send(syntheticBody);

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe("invalid_request_error");
    expect(response.text).not.toContain(syntheticBody);
  });

  it("maps a truncated parser body to a safe 400 response", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { createErrorHandler } =
      await import("../apps/api/src/utils/error-handler.js");
    const app = express();
    const parserError = Object.assign(new Error("request aborted"), {
      type: "request.aborted",
      status: 400,
      body: syntheticBody,
    });
    const failWithParserError: TestHandler = (_req, _res, next) => next(parserError);
    app.post("/truncated", failWithParserError);
    app.use(createErrorHandler());

    const response = await testRequest(app).post("/truncated");

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe("invalid_request_error");
    expect(response.text).not.toContain(syntheticBody);
    expect(response.text).not.toContain("request aborted");
    expect(stderr).not.toHaveBeenCalled();
  });

  it("forwards asynchronous failures to the safe global error handler", async () => {
    const { createErrorHandler } =
      await import("../apps/api/src/utils/error-handler.js");
    const app = express();
    const setRequestId: TestHandler = (_req, res, next) => {
      res.setHeader("X-Request-ID", "request-test-id");
      next();
    };
    app.use(setRequestId);
    const asyncFailure: TestHandler = () =>
      Promise.reject(new Error(`/srv/private/app.ts ${syntheticBody}`));
    app.get("/async", asyncFailure);
    app.use(createErrorHandler());

    const response = await testRequest(app).get("/async");

    expect(response.status).toBe(500);
    expect(response.headers["x-request-id"]).toBe("request-test-id");
    expect(response.body.error.type).toBe("internal_error");
    expect(response.text).not.toContain(syntheticBody);
    expect(response.text).not.toContain("/srv/private");
    expect(response.text).not.toContain("app.ts");
    expect(response.text).not.toContain("Error:");
    expect(response.text).not.toContain("tests/http-errors.test.ts");
  });

  it("preserves typed OpenAI status and code while sanitizing its public message", async () => {
    const { createErrorHandler } =
      await import("../apps/api/src/utils/error-handler.js");
    const app = express();
    const failWithHttpError: TestHandler = (_req, _res, next) =>
      next(
        new HttpError(
          `token=${syntheticBody} /home/private/provider.ts`,
          422,
          "invalid_request_error",
          "model",
        ),
      );
    app.post("/typed-error", failWithHttpError);
    app.use(createErrorHandler());

    const response = await testRequest(app).post("/typed-error");

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("invalid_request_error");
    expect(response.body.error.param).toBe("model");
    expect(response.text).not.toContain(syntheticBody);
    expect(response.text).not.toContain("/home/private");
    expect(response.text).not.toContain("provider.ts");
  });

  it("preserves request IDs and does not write a second response after headers are sent", async () => {
    const { createErrorHandler } =
      await import("../apps/api/src/utils/error-handler.js");
    const app = express();
    const setRequestId: TestHandler = (_req, res, next) => {
      res.setHeader("X-Request-ID", "request-test-id");
      next();
    };
    app.use(setRequestId);
    const failAfterWrite: TestHandler = (_req, res, next) => {
      res.write("partial response");
      next(new Error(syntheticBody));
    };
    app.get("/stream-error", failAfterWrite);
    app.use(createErrorHandler());

    const result = await testRequest(app)
      .get("/stream-error")
      .then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      );

    if ("response" in result) {
      expect(result.response.headers["x-request-id"]).toBe("request-test-id");
      expect(result.response.text).toBe("partial response");
      expect(result.response.text).not.toContain(syntheticBody);
      return;
    }

    expect(result.error).toBeDefined();
    expect(result.error).toBeInstanceOf(Error);
    if (result.error instanceof Error) {
      expect(result.error.message).toMatch(/abort|reset|socket/iu);
    }
  });

  it("accepts Express error middleware through its four-argument handler contract", async () => {
    const { createErrorHandler } =
      await import("../apps/api/src/utils/error-handler.js");
    const handler: unknown = createErrorHandler();
    expect((handler as { readonly length: number }).length).toBe(4);
  });
});
