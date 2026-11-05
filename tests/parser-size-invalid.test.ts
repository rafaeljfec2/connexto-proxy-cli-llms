import { createRequire } from "node:module";
import request from "supertest";
import { describe, expect, it } from "vitest";

interface TestResponse {
  setHeader(name: string, value: string): void;
  write(chunk: string): boolean;
}

interface TestNext {
  (error?: unknown): void;
}

type TestHandler = (request: unknown, response: TestResponse, next: TestNext) => void;

interface TestExpressApp {
  post(path: string, ...handlers: TestHandler[]): void;
  use(...handlers: ReadonlyArray<unknown>): void;
}

type TestExpressFactory = () => TestExpressApp;

const express = createRequire(new URL("../apps/api/package.json", import.meta.url))(
  "express",
) as TestExpressFactory;
const syntheticBody = "TRUNCATED_BODY_SECRET_13a7";

describe("Body parser size errors", () => {
  it("maps content-length mismatches to a safe 400 error", async () => {
    const { createErrorHandler } =
      await import("../apps/api/src/utils/error-handler.js");
    const app = express();
    const parserError = Object.assign(
      new Error("request size did not match content length"),
      {
        type: "request.size.invalid",
        status: 400,
        body: syntheticBody,
      },
    );
    const failWithSizeError: TestHandler = (_req, _res, next) => next(parserError);
    app.post("/size-mismatch", failWithSizeError);
    app.use(createErrorHandler());

    const response = await request(
      app as unknown as Parameters<typeof request>[0],
    ).post("/size-mismatch");

    expect(response.status).toBe(400);
    expect(response.body.error.type).toBe("invalid_request_error");
    expect(response.text).not.toContain(syntheticBody);
    expect(response.text).not.toContain("request size did not match");
  });
});
