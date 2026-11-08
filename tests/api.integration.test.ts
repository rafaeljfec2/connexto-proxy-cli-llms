import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  buildApp,
  createLogger,
  loadEnvFileIfPresent,
  setLogger,
} from "@agent-runtime-gateway/api";
import { Writable } from "node:stream";

loadEnvFileIfPresent();

const apiKey = process.env.CURSOR_API_KEY?.trim();
const describeLiveApi = apiKey ? describe : describe.skip;

interface CapturedLog {
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

describeLiveApi("Gateway Live API Integration Suite", () => {
  it("executes non-streaming POST /v1/chat/completions against real Cursor API", async () => {
    const { logs, stream } = captureLogs();
    const logger = createLogger({ destination: stream, level: "info" });
    setLogger(logger);

    const app = buildApp({ HOST: "127.0.0.1", GATEWAY_API_TOKEN: undefined });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${apiKey}`)
      .set("Origin", "http://localhost:5173")
      .send({
        model: "composer-2.5",
        messages: [{ role: "user", content: "Reply with the single word: PONG" }],
        stream: false,
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(res.headers["access-control-expose-headers"]).toContain("X-Request-ID");

    const body = res.body as {
      readonly id?: string;
      readonly choices?: readonly [
        { readonly message?: { readonly content?: string } },
      ];
      readonly cursor_run_id?: string;
    };

    expect(body.id).toMatch(/^chatcmpl_/);
    expect(body.choices?.[0]?.message?.content).toBeDefined();
    expect(body.choices?.[0]?.message?.content?.toUpperCase()).toContain("PONG");
    expect(body.cursor_run_id).toBeDefined();

    // Verify correlated logs
    const requestLog = logs.find(
      (entry) => entry.msg === "request completed" && entry.status === 200,
    );
    expect(requestLog).toBeDefined();
    expect(requestLog?.requestId).toBe(res.headers["x-request-id"]);

    const providerLog = logs.find(
      (entry) =>
        entry.provider === "cursor" && entry.msg === "provider execution completed",
    );
    expect(providerLog).toBeDefined();
    expect(providerLog?.status).toBe("completed");
    expect(typeof providerLog?.durationMs).toBe("number");
  }, 90_000);

  it("executes streaming (SSE) POST /v1/chat/completions against real Cursor API", async () => {
    const { logs, stream } = captureLogs();
    const logger = createLogger({ destination: stream, level: "info" });
    setLogger(logger);

    const app = buildApp({ HOST: "127.0.0.1", GATEWAY_API_TOKEN: undefined });
    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${apiKey}`)
      .set("Origin", "http://localhost:5173")
      .send({
        model: "composer-2.5",
        messages: [{ role: "user", content: "Say hello briefly in one sentence." }],
        stream: true,
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["x-request-id"]).toBeDefined();

    const rawText = res.text;
    expect(rawText).toContain("data: {");
    expect(rawText).toContain("data: [DONE]");

    // Verify streaming correlation and time to first delta
    const streamLog = logs.find(
      (entry) =>
        entry.provider === "cursor" && entry.msg === "provider stream completed",
    );
    expect(streamLog).toBeDefined();
    expect(streamLog?.requestId).toBe(res.headers["x-request-id"]);
    expect(typeof streamLog?.durationMs).toBe("number");
    expect(typeof streamLog?.timeToFirstDeltaMs).toBe("number");
    expect(streamLog?.timeToFirstDeltaMs).toBeGreaterThan(0);

    // Negative validation: confirm no secrets in logs
    const loggedText = JSON.stringify(logs);
    expect(loggedText).not.toContain(apiKey);
    expect(loggedText).not.toContain("Bearer");
  }, 90_000);

  it("executes POST /v1/responses against real Cursor API", async () => {
    const app = buildApp({ HOST: "127.0.0.1", GATEWAY_API_TOKEN: undefined });
    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", `Bearer ${apiKey}`)
      .set("Origin", "http://localhost:5173")
      .send({
        model: "composer-2.5",
        input: [{ role: "user", content: "Reply with the single word: OK" }],
        stream: false,
      });

    expect(res.status).toBe(200);
    expect(res.headers["x-request-id"]).toBeDefined();

    const body = res.body as {
      readonly id?: string;
      readonly output?: readonly unknown[];
      readonly status?: string;
    };

    expect(body.id).toMatch(/^resp_/);
    expect(body.status).toBe("completed");
  }, 90_000);
});
