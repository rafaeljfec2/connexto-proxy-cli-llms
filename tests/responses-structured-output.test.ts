import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, loadEnv } from "@agent-runtime-gateway/api";
import type { AgentProvider } from "@agent-runtime-gateway/core";
import { getGatewayServices } from "../apps/api/src/services/gateway.js";
import {
  createCompletedRun,
  createStubProvider,
} from "../packages/core/tests/helpers/stub-provider.js";

interface ExecutorWithRouter {
  router: {
    registry: {
      providers: Map<string, AgentProvider>;
    };
  };
}

describe("POST /v1/responses structured output route enforcement", () => {
  const app = buildApp(loadEnv({ HOST: "127.0.0.1" }));
  const services = getGatewayServices();
  const providers = (services.executor as unknown as ExecutorWithRouter).router.registry
    .providers;
  let originalCursor: AgentProvider | undefined;
  let nextOutput = '{"name":"Connexto AI-Hub","language":"Go","type":"API"}';

  const strictFormat = {
    type: "json_schema",
    name: "connexto_meta",
    strict: true,
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        language: { type: "string" },
        type: { type: "string" },
      },
      required: ["name", "language", "type"],
      additionalProperties: false,
    },
  };

  beforeAll(() => {
    originalCursor = providers.get("cursor");
    const stubCursor = createStubProvider("cursor", {
      execute: (input) =>
        Promise.resolve(createCompletedRun("cursor", input.sessionId, nextOutput)),
    });
    providers.set("cursor", stubCursor);
  });

  afterAll(() => {
    if (originalCursor !== undefined) {
      providers.set("cursor", originalCursor);
    }
  });

  it("unwraps fenced valid strict json_schema output and stores sanitized text", async () => {
    nextOutput =
      '```json\n{"name":"Connexto AI-Hub","language":"Go","type":"API"}\n```';

    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", "Bearer test-cursor-key")
      .send({
        model: "composer-2.5",
        input: "Return metadata",
        stream: false,
        store: true,
        text: { format: strictFormat },
      });

    expect(res.status).toBe(200);
    const body = res.body as {
      id: string;
      output?: readonly { content?: readonly { text?: string }[] }[];
    };
    const outputText = body.output?.[0]?.content?.[0]?.text;
    expect(outputText).toBe('{"name":"Connexto AI-Hub","language":"Go","type":"API"}');
    expect(JSON.parse(outputText ?? "")).toEqual({
      name: "Connexto AI-Hub",
      language: "Go",
      type: "API",
    });

    const getRes = await request(app)
      .get(`/v1/responses/${body.id}`)
      .set("Authorization", "Bearer test-cursor-key");
    expect(getRes.status).toBe(200);
    const storedBody = getRes.body as {
      output?: readonly { content?: readonly { text?: string }[] }[];
    };
    expect(storedBody.output?.[0]?.content?.[0]?.text).toBe(outputText);
  });

  it("returns 502 upstream_invalid_structured_output when model violates strict schema", async () => {
    nextOutput = '{"name":"Connexto AI-Hub","language":"Go","extra":true}';

    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", "Bearer test-cursor-key")
      .send({
        model: "composer-2.5",
        input: "Return metadata",
        stream: false,
        text: { format: strictFormat },
      });

    expect(res.status).toBe(502);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe("upstream_invalid_structured_output");
    expect(body.error.message).toContain("type is required");
  });

  it("returns 502 when model wraps output with explanatory prose", async () => {
    nextOutput =
      'Here is the JSON:\n```json\n{"name":"A","language":"Go","type":"API"}\n```';

    const res = await request(app)
      .post("/v1/responses")
      .set("Authorization", "Bearer test-cursor-key")
      .send({
        model: "composer-2.5",
        input: "Return metadata",
        stream: false,
        text: { format: strictFormat },
      });

    expect(res.status).toBe(502);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      "upstream_invalid_structured_output",
    );
  });
});
