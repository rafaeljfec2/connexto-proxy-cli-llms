import { Writable } from "node:stream";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, createLogger, loadEnv, setLogger } from "@agent-runtime-gateway/api";
import type { AgentExecutionInput } from "@agent-runtime-gateway/core";
import { getGatewayServices } from "../apps/api/src/services/gateway.js";
import {
  createCompletedRun,
  createStubProvider,
} from "../packages/core/tests/helpers/stub-provider.js";
import { secureTokenEquals } from "../apps/api/src/utils/secure-token.js";
import {
  LOCAL_PRINCIPAL,
  principalFromCredential,
} from "../apps/api/src/utils/identity.js";

const gatewayToken = "synthetic-gateway-token-123";
const responseId = "resp_gateway_auth_test";
const services = getGatewayServices();
const providerExecute = vi.fn((input: AgentExecutionInput) =>
  Promise.resolve(
    createCompletedRun("cursor", input.sessionId, "mock provider response"),
  ),
);

function createAuthenticatedApp() {
  return buildApp(
    loadEnv({
      HOST: "127.0.0.1",
      GATEWAY_API_TOKEN: gatewayToken,
      CORS_ORIGINS: "http://localhost:5173",
    }),
  );
}

describe("gateway authentication", () => {
  beforeAll(() => {
    const cursorProvider = createStubProvider("cursor", {
      execute: providerExecute,
    });
    const registryHolder = services.executor as unknown as {
      readonly router: {
        readonly registry: {
          readonly providers: Map<string, ReturnType<typeof createStubProvider>>;
        };
      };
    };
    registryHolder.router.registry.providers.set("cursor", cursorProvider);
  });

  it("uses a fixed-size constant-time token comparison and rejects empty values", () => {
    expect(secureTokenEquals("same-length-token", "same-length-token")).toBe(true);
    expect(secureTokenEquals("same-length-token", "different-length-token")).toBe(
      false,
    );
    expect(secureTokenEquals("", "")).toBe(false);
  });

  it("allows cursor auth interaction HTML without gateway key", async () => {
    const app = createAuthenticatedApp();
    const response = await request(app).get(
      "/v1/providers/cursor/auth/00000000-0000-4000-8000-000000000001/interaction",
    );
    expect(response.status).not.toBe(401);
    expect(response.status).toBe(404);
  });

  it("keeps only the explicit metadata endpoints public", async () => {
    const app = createAuthenticatedApp();
    const responses = await Promise.all([
      request(app).get("/health"),
      request(app).get("/"),
      request(app).get("/v1"),
      request(app).get("/v1/models"),
      request(app).get("/v1/models/composer-2.5"),
      request(app).head("/health"),
      request(app)
        .options("/v1/chat/completions")
        .set("Origin", "http://localhost:5173")
        .set("Access-Control-Request-Method", "POST")
        .set("Access-Control-Request-Headers", "x-gateway-api-key"),
    ]);

    expect(responses.map(({ status }) => status)).toEqual([
      200, 200, 200, 200, 200, 200, 204,
    ]);
    expect(responses[6]?.headers["access-control-allow-headers"]).toContain(
      "x-gateway-api-key",
    );
  });

  it("preserves trusted loopback access when no gateway token is configured", async () => {
    const localApp = buildApp({
      HOST: "127.0.0.1",
      GATEWAY_API_TOKEN: undefined,
    });
    services.responseStore.set(responseId, {
      id: responseId,
      created: 1,
      model: "composer-2.5",
      inputItems: [{ role: "user", content: "synthetic local input" }],
      responseData: { id: responseId, output: ["synthetic local output"] },
      ownerPrincipal: LOCAL_PRINCIPAL,
    });

    try {
      const response = await request(localApp).get(`/v1/responses/${responseId}`);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(responseId);
    } finally {
      services.responseStore.delete(responseId);
    }
  });

  it("requires the gateway token for every provider and response operation", async () => {
    providerExecute.mockClear();
    const app = createAuthenticatedApp();
    services.responseStore.set(responseId, {
      id: responseId,
      created: 1,
      model: "composer-2.5",
      inputItems: [{ role: "user", content: "synthetic private input" }],
      responseData: { id: responseId, output: ["synthetic private output"] },
      ownerPrincipal: principalFromCredential(gatewayToken),
    });

    try {
      const responses = await Promise.all([
        request(app)
          .post("/v1/chat/completions")
          .send({ messages: [{ role: "user", content: "hello" }] }),
        request(app).post("/v1/completions").send({ prompt: "hello" }),
        request(app).post("/v1/responses").send({ input: "hello" }),
        request(app).post("/v1/responses/input_tokens").send({ input: "hello" }),
        request(app).post("/v1/responses/compact").send({ input: "hello" }),
        request(app).get(`/v1/responses/${responseId}`),
        request(app).get(`/v1/responses/${responseId}/input_items`),
        request(app).post(`/v1/responses/${responseId}/cancel`),
        request(app).delete(`/v1/responses/${responseId}`),
        request(app).get("/unknown-private-route"),
        request(app)
          .post("/v1/responses/input_tokens?x-gateway-api-key=query-token")
          .send({
            input: "hello",
          }),
      ]);

      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(response.body.error.message).toBe("Missing or invalid gateway API key");
      }
      expect(providerExecute).not.toHaveBeenCalled();
      expect(services.responseStore.has(responseId)).toBe(true);

      const authorizedResponse = await request(app)
        .get(`/v1/responses/${responseId}`)
        .set("X-Gateway-API-Key", gatewayToken);
      expect(authorizedResponse.status).toBe(200);
      expect(authorizedResponse.body.id).toBe(responseId);

      const authorizedInputItems = await request(app)
        .get(`/v1/responses/${responseId}/input_items`)
        .set("X-Gateway-API-Key", gatewayToken);
      expect(authorizedInputItems.status).toBe(200);
      expect(authorizedInputItems.body.data).toHaveLength(1);

      const authorizedDelete = await request(app)
        .delete(`/v1/responses/${responseId}`)
        .set("X-Gateway-API-Key", gatewayToken);
      expect(authorizedDelete.status).toBe(200);
      expect(services.responseStore.has(responseId)).toBe(false);
    } finally {
      services.responseStore.delete(responseId);
    }
  });

  it("does not accept a Cursor bearer credential as the gateway token", async () => {
    providerExecute.mockClear();
    const response = await request(createAuthenticatedApp())
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer synthetic-cursor-key")
      .send({ messages: [{ role: "user", content: "hello" }] });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Missing or invalid gateway API key");
    expect(providerExecute).not.toHaveBeenCalled();
  });

  it("rejects an invalid gateway token without invoking the provider", async () => {
    providerExecute.mockClear();
    const response = await request(createAuthenticatedApp())
      .post("/v1/chat/completions")
      .set("X-Gateway-API-Key", "synthetic-invalid-gateway-token")
      .set("Authorization", "Bearer synthetic-cursor-key")
      .send({ messages: [{ role: "user", content: "hello" }] });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe("Missing or invalid gateway API key");
    expect(providerExecute).not.toHaveBeenCalled();
  });

  it("accepts the gateway header separately from the Cursor credential", async () => {
    const response = await request(createAuthenticatedApp())
      .post("/v1/chat/completions")
      .set("X-Gateway-API-Key", gatewayToken)
      .set("Authorization", "Bearer synthetic-cursor-key")
      .send({ messages: [{ role: "user", content: "hello" }] });

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe("mock provider response");
    expect(providerExecute).toHaveBeenCalledTimes(1);
  });

  it("does not treat a gateway token as a Cursor provider credential", async () => {
    const previousCursorApiKey = process.env.CURSOR_API_KEY;
    providerExecute.mockClear();
    delete process.env.CURSOR_API_KEY;
    try {
      const response = await request(createAuthenticatedApp())
        .post("/v1/chat/completions")
        .set("X-Gateway-API-Key", gatewayToken)
        .send({ messages: [{ role: "user", content: "hello" }] });

      expect(response.status).toBe(401);
      expect(response.body.error.message).toBe("Missing Cursor API key");
      expect(providerExecute).not.toHaveBeenCalled();

      const duplicatedGatewayCredential = await request(createAuthenticatedApp())
        .post("/v1/chat/completions")
        .set("X-Gateway-API-Key", gatewayToken)
        .set("Authorization", `Bearer ${gatewayToken}`)
        .send({ messages: [{ role: "user", content: "hello" }] });

      expect(duplicatedGatewayCredential.status).toBe(401);
      expect(duplicatedGatewayCredential.body.error.message).toBe(
        "Missing Cursor API key",
      );
      expect(providerExecute).not.toHaveBeenCalled();
    } finally {
      if (previousCursorApiKey === undefined) {
        delete process.env.CURSOR_API_KEY;
      } else {
        process.env.CURSOR_API_KEY = previousCursorApiKey;
      }
    }
  });

  it("does not emit supplied gateway credentials in request logs", async () => {
    let emittedLogs = "";
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        emittedLogs += chunk.toString("utf8");
        callback();
      },
    });
    setLogger(createLogger({ destination, level: "info" }));

    await request(createAuthenticatedApp())
      .post("/v1/responses/input_tokens")
      .set("X-Gateway-API-Key", gatewayToken)
      .send({ input: "hello" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(emittedLogs).not.toContain(gatewayToken);
  });
});
