import { buildApp, loadEnv } from "@agent-runtime-gateway/api";
import { getGatewayServices } from "../apps/api/src/services/gateway.js";
import {
  createCompletedRun,
  createStubProvider,
} from "../packages/core/tests/helpers/stub-provider.js";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

describe("Composer API HTTP Compatibility Suite", () => {
  const app = buildApp(
    loadEnv({
      HOST: "127.0.0.1",
      CORS_ORIGINS: "http://localhost:5173",
    }),
  );
  const services = getGatewayServices();

  beforeAll(() => {
    // Inject a controllable stub provider for cursor to test full execution loops without network
    const stubCursor = createStubProvider("cursor", {
      execute: (input) =>
        Promise.resolve(
          createCompletedRun(
            "cursor",
            input.sessionId,
            `Echo: ${input.message.slice(0, 50)}`,
          ),
        ),
    });

    // Re-register cursor in the live registry
    (services.executor as any).router.registry.providers.set("cursor", stubCursor);
  });

  describe("CORS and Options", () => {
    it("responds 204 to OPTIONS requests with proper CORS headers", async () => {
      const res = await request(app)
        .options("/v1/chat/completions")
        .set("Origin", "http://localhost:5173")
        .set("Access-Control-Request-Method", "POST")
        .set(
          "Access-Control-Request-Headers",
          "authorization,content-type,x-gateway-api-key",
        );
      expect(res.status).toBe(204);
      expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
      expect(res.headers["access-control-allow-headers"]).toContain(
        "x-gateway-api-key",
      );
      expect(res.headers["access-control-expose-headers"]).toBeUndefined();
      expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    });
  });

  describe("GET / and GET /v1 (Service Meta)", () => {
    it("returns service metadata on GET /", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.body.service).toBe("API for Cursor");
      expect(res.body.models).toContain("composer-2.5");
    });

    it("returns service metadata on GET /v1", async () => {
      const res = await request(app).get("/v1");
      expect(res.status).toBe(200);
      expect(res.body.service).toBe("API for Cursor");
    });
  });

  describe("GET /v1/models and GET /v1/models/:model", () => {
    it("lists supported models in OpenAI format", async () => {
      const res = await request(app).get("/v1/models");
      expect(res.status).toBe(200);
      expect(res.body.object).toBe("list");
      expect(Array.isArray(res.body.data)).toBe(true);

      const composerModel = res.body.data.find(
        (m: { id: string }) => m.id === "composer-2.5",
      );
      expect(composerModel).toBeDefined();
      expect(composerModel.object).toBe("model");
      expect(composerModel.owned_by).toBe("cursor");
    });

    it("returns a specific model metadata", async () => {
      const res = await request(app).get("/v1/models/composer-2.5");
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("composer-2.5");
      expect(res.body.object).toBe("model");
    });

    it("returns 404 for unknown model", async () => {
      const res = await request(app).get("/v1/models/unknown-model-xyz");
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("model_not_found");
    });
  });

  describe("POST /v1/chat/completions", () => {
    it("rejects request without messages array (400)", async () => {
      const res = await request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer dummy-key")
        .send({ model: "composer-2.5" });

      expect(res.status).toBe(400);
      expect(res.body.error.type).toBe("invalid_request_error");
      expect(res.body.error.message).toContain("messages");
    });

    it("rejects request without API key (401)", async () => {
      const prevEnv = process.env.CURSOR_API_KEY;
      delete process.env.CURSOR_API_KEY;
      try {
        const res = await request(app)
          .post("/v1/chat/completions")
          .send({
            model: "composer-2.5",
            messages: [{ role: "user", content: "Hello" }],
          });

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe("unauthorized");
      } finally {
        if (prevEnv) process.env.CURSOR_API_KEY = prevEnv;
      }
    });

    it("executes non-streaming completion successfully (200)", async () => {
      const res = await request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer test-key-123")
        .send({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Write a hello world" }],
          stream: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.object).toBe("chat.completion");
      expect(res.body.id).toMatch(/^chatcmpl_/);
      expect(res.body.model).toBe("composer-2.5");
      expect(res.body.choices).toHaveLength(1);
      expect(res.body.choices[0].message.role).toBe("assistant");
      expect(res.body.choices[0].message.content).toContain("Echo:");
      expect(res.body.choices[0].finish_reason).toBe("stop");
      expect(res.body.usage).toBeDefined();
      expect(res.body.usage.prompt_tokens).toBeGreaterThan(0);
    });

    it("executes streaming completion SSE successfully (200)", async () => {
      const res = await request(app)
        .post("/v1/chat/completions")
        .set("Authorization", "Bearer test-key-123")
        .send({
          model: "composer-2.5",
          messages: [{ role: "user", content: "Stream test" }],
          stream: true,
        });

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");

      const text = res.text;
      expect(text).toContain("data: {");
      expect(text).toContain("chat.completion.chunk");
      expect(text).toContain("[DONE]");
    });
  });

  describe("POST /v1/completions (Legacy text completion)", () => {
    it("handles legacy text completion (200)", async () => {
      const res = await request(app)
        .post("/v1/completions")
        .set("Authorization", "Bearer test-key-123")
        .send({
          model: "composer-2.5",
          prompt: "Legacy prompt test",
          stream: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.object).toBe("text_completion");
      expect(res.body.id).toMatch(/^cmpl_/);
      expect(res.body.choices[0].text).toContain("Echo:");
    });
  });

  describe("OpenAI Responses API endpoints", () => {
    let createdResponseId = "";

    it("POST /v1/responses creates and stores response (200)", async () => {
      const res = await request(app)
        .post("/v1/responses")
        .set("Authorization", "Bearer test-key-123")
        .send({
          model: "composer-2.5",
          input: "Explain quantum computing briefly",
          stream: false,
        });

      expect(res.status).toBe(200);
      expect(res.body.object).toBe("response");
      expect(res.body.id).toMatch(/^resp_/);
      expect(res.body.output).toBeDefined();
      expect(res.body.output[0].content[0].text).toContain("Echo:");

      createdResponseId = res.body.id;
    });

    it("GET /v1/responses/:id retrieves stored response", async () => {
      const res = await request(app).get(`/v1/responses/${createdResponseId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(createdResponseId);
      expect(res.body.object).toBe("response");
    });

    it("GET /v1/responses/:id/input_items retrieves stored input items", async () => {
      const res = await request(app).get(
        `/v1/responses/${createdResponseId}/input_items`,
      );
      expect(res.status).toBe(200);
      expect(res.body.object).toBe("list");
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("POST /v1/responses/:id/cancel returns 400 with synchronous notice", async () => {
      const res = await request(app).post(`/v1/responses/${createdResponseId}/cancel`);
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain(
        "Only background responses can be cancelled",
      );
    });

    it("DELETE /v1/responses/:id deletes stored response", async () => {
      const res = await request(app).delete(`/v1/responses/${createdResponseId}`);
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      const check = await request(app).get(`/v1/responses/${createdResponseId}`);
      expect(check.status).toBe(404);
    });

    it("POST /v1/responses/input_tokens estimates input tokens", async () => {
      const res = await request(app)
        .post("/v1/responses/input_tokens")
        .send({ input: "Sample input for token estimation" });

      expect(res.status).toBe(200);
      expect(res.body.object).toBe("response.input_tokens");
      expect(res.body.input_tokens).toBeGreaterThan(0);
    });

    it("POST /v1/responses/compact returns compaction result", async () => {
      const res = await request(app)
        .post("/v1/responses/compact")
        .set("Authorization", "Bearer test-key-123")
        .send({ input: "Large conversational history to compact" });

      expect(res.status).toBe(200);
      expect(res.body.object).toBe("response.compaction");
      expect(res.body.compacted_context).toBeDefined();
    });
  });
});
