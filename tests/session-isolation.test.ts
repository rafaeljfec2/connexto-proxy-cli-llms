import request from "supertest";
import { Writable } from "node:stream";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp, createLogger, loadEnv, setLogger } from "@agent-runtime-gateway/api";
import { openAiErrorPayload } from "@agent-runtime-gateway/compatibility-openai";
import type { AgentExecutionInput } from "@agent-runtime-gateway/core";
import { getGatewayServices } from "../apps/api/src/services/gateway.js";
import {
  createCompletedRun,
  createStubProvider,
} from "../packages/core/tests/helpers/stub-provider.js";
import {
  LOCAL_PRINCIPAL,
  principalFromCredential,
} from "../apps/api/src/utils/identity.js";
import { codexWorkspaceInstructions } from "./helpers/codex-workspace.js";

const consumerTokenA = "synthetic-gateway-token-A";
const consumerTokenB = "synthetic-gateway-token-B";
const consumerPrincipalA = principalFromCredential(consumerTokenA);
const consumerPrincipalB = principalFromCredential(consumerTokenB);
const cursorKeyA = "synthetic-cursor-key-A";
const cursorKeyB = "synthetic-cursor-key-B";

const providerExecute = vi.fn((input: AgentExecutionInput) =>
  Promise.resolve(
    createCompletedRun("cursor", input.sessionId, "mock provider response"),
  ),
);
const services = getGatewayServices();

function createIsolatedApp() {
  return buildApp(
    loadEnv({
      HOST: "127.0.0.1",
      GATEWAY_API_TOKEN: consumerTokenA,
      GATEWAY_API_TOKENS: `${consumerTokenB}`,
      CORS_ORIGINS: "http://localhost:5173",
    }),
  );
}

function requestAs(app: ReturnType<typeof createIsolatedApp>, consumer: "A" | "B") {
  const gatewayToken = consumer === "A" ? consumerTokenA : consumerTokenB;
  const cursorKey = consumer === "A" ? cursorKeyA : cursorKeyB;
  const gatewayHeaders = { "X-Gateway-API-Key": gatewayToken };
  return {
    createResponse: (
      body: Record<string, unknown> = {},
      headers: Record<string, string> = {},
    ) =>
      request(app)
        .post("/v1/responses")
        .set(gatewayHeaders)
        .set("Authorization", `Bearer ${cursorKey}`)
        .set(headers)
        .send({
          instructions: codexWorkspaceInstructions,
          input: "hello",
          ...body,
        }),
    get: (path: string) => request(app).get(path).set(gatewayHeaders),
    cancel: (id: string) =>
      request(app).post(`/v1/responses/${id}/cancel`).set(gatewayHeaders),
    delete: (id: string) =>
      request(app).delete(`/v1/responses/${id}`).set(gatewayHeaders),
  };
}

const notFoundPayload = openAiErrorPayload("Response not found", "not_found");

async function createResponseFor(
  consumer: "A" | "B",
  body: Record<string, unknown> = {},
) {
  const response = await requestAs(createIsolatedApp(), consumer).createResponse(body);
  expect(response.status).toBe(200);
  return { id: String(response.body.id) };
}

function seedResponse(
  id: string,
  ownerPrincipal: string | undefined,
  sampleInput: string,
): void {
  services.responseStore.set(id, {
    id,
    created: 1,
    model: "composer-2.5",
    inputItems: [{ role: "user", content: sampleInput }],
    responseData: { id, output: [sampleInput] },
    ...(ownerPrincipal === undefined ? {} : { ownerPrincipal }),
  });
}

describe("session isolation", () => {
  beforeAll(() => {
    setLogger(createLogger({ level: "silent" }));
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

  it("derives distinct stable principals from distinct gateway credentials", () => {
    expect(consumerPrincipalA).not.toBe(consumerPrincipalB);
    expect(consumerPrincipalA).toBe(principalFromCredential(consumerTokenA));
    expect(principalFromCredential(consumerTokenA)).not.toContain(consumerTokenA);
    expect(LOCAL_PRINCIPAL).toBe("local");
  });

  it("creates a Response owned by the authenticated consumer", async () => {
    const app = createIsolatedApp();
    const consumerA = requestAs(app, "A");
    const response = await consumerA.createResponse({});

    expect(response.status).toBe(200);
    const stored = services.responseStore.get(String(response.body.id));
    expect(stored?.ownerPrincipal).toBe(consumerPrincipalA);
    expect(JSON.stringify(stored)).not.toContain(consumerTokenA);
    expect(JSON.stringify(stored)).not.toContain(cursorKeyA);
    services.responseStore.delete(String(response.body.id));
  });

  it("lets consumer A read its own Response", async () => {
    const app = createIsolatedApp();
    const consumerA = requestAs(app, "A");
    const created = await createResponseFor("A");

    const readResponse = await consumerA.get(`/v1/responses/${created.id}`);
    expect(readResponse.status).toBe(200);
    expect(readResponse.body.id).toBe(created.id);
    services.responseStore.delete(created.id);
  });

  it("rejects consumer B reading consumer A's Response without leaking existence", async () => {
    const app = createIsolatedApp();
    const created = await createResponseFor("A");
    try {
      const foreignRead = await requestAs(app, "B").get(`/v1/responses/${created.id}`);

      expect(foreignRead.status).toBe(404);
      expect(foreignRead.body).toEqual(notFoundPayload);

      const unknownRead = await requestAs(app, "B").get("/v1/responses/resp_missing");
      expect(unknownRead.status).toBe(404);
      expect(unknownRead.body).toEqual(notFoundPayload);
      expect(foreignRead.text).toEqual(unknownRead.text);
    } finally {
      services.responseStore.delete(created.id);
    }
  });

  it("rejects consumer B cancelling consumer A's Response", async () => {
    const app = createIsolatedApp();
    const created = await createResponseFor("A");
    try {
      const foreignCancel = await requestAs(app, "B").cancel(created.id);
      expect(foreignCancel.status).toBe(404);
      expect(foreignCancel.body).toEqual(notFoundPayload);

      const ownerCancel = await requestAs(app, "A").cancel(created.id);
      expect(ownerCancel.status).toBe(400);
      expect(ownerCancel.body.error.code).toBe("invalid_request_error");
    } finally {
      services.responseStore.delete(created.id);
    }
  });

  it("rejects consumer B deleting consumer A's Response", async () => {
    const app = createIsolatedApp();
    const created = await createResponseFor("A");
    try {
      const foreignDelete = await requestAs(app, "B").delete(created.id);
      expect(foreignDelete.status).toBe(404);
      expect(foreignDelete.body).toEqual(notFoundPayload);
      expect(services.responseStore.has(created.id)).toBe(true);

      const ownerDelete = await requestAs(app, "A").delete(created.id);
      expect(ownerDelete.status).toBe(200);
      expect(ownerDelete.body.deleted).toBe(true);
      expect(services.responseStore.has(created.id)).toBe(false);
    } finally {
      services.responseStore.delete(created.id);
    }
  });

  it("rejects consumer B reading consumer A's input items", async () => {
    const app = createIsolatedApp();
    const created = await createResponseFor("A");
    try {
      const foreignItems = await requestAs(app, "B").get(
        `/v1/responses/${created.id}/input_items`,
      );
      expect(foreignItems.status).toBe(404);
      expect(foreignItems.body).toEqual(notFoundPayload);

      const ownerItems = await requestAs(app, "A").get(
        `/v1/responses/${created.id}/input_items`,
      );
      expect(ownerItems.status).toBe(200);
      expect(ownerItems.body.data).toHaveLength(1);
    } finally {
      services.responseStore.delete(created.id);
    }
  });

  it("rejects consumer B chaining onto consumer A's previous_response_id", async () => {
    const app = createIsolatedApp();
    const created = await createResponseFor("A");
    providerExecute.mockClear();
    try {
      const foreignChain = await requestAs(app, "B").createResponse({
        previous_response_id: created.id,
      });
      expect(foreignChain.status).toBe(404);
      expect(foreignChain.body).toEqual(notFoundPayload);
      expect(providerExecute).not.toHaveBeenCalled();

      const unknownChain = await requestAs(app, "B").createResponse({
        previous_response_id: "resp_missing",
      });
      expect(unknownChain.status).toBe(404);
      expect(unknownChain.body).toEqual(notFoundPayload);
      expect(foreignChain.text).toEqual(unknownChain.text);
    } finally {
      services.responseStore.delete(created.id);
    }
  });

  it("lets consumer A chain onto its own previous_response_id", async () => {
    const app = createIsolatedApp();
    const created = await createResponseFor("A");
    try {
      const chain = await requestAs(app, "A").createResponse({
        previous_response_id: created.id,
      });
      expect(chain.status).toBe(200);
      const stored = services.responseStore.get(String(chain.body.id));
      expect(stored?.ownerPrincipal).toBe(consumerPrincipalA);
      expect(stored?.sdkSessionKey).toBe(
        services.responseStore.get(created.id)?.sdkSessionKey,
      );
      services.responseStore.delete(String(chain.body.id));
    } finally {
      services.responseStore.delete(created.id);
    }
  });

  it("scopes session affinity so the same consumer reuses its own context", async () => {
    const app = createIsolatedApp();
    providerExecute.mockClear();
    await requestAs(app, "A").createResponse(
      {},
      { "x-session-affinity": "shared-affinity-id" },
    );
    await requestAs(app, "A").createResponse(
      {},
      { "x-session-affinity": "shared-affinity-id" },
    );

    const sessionIds = providerExecute.mock.calls.map(([input]) => input.sessionId);
    expect(sessionIds.length).toBe(2);
    expect(new Set(sessionIds).size).toBe(1);
  });

  it("isolates equal affinity IDs across different consumers", async () => {
    const app = createIsolatedApp();
    providerExecute.mockClear();
    await requestAs(app, "A").createResponse(
      {},
      { "x-session-affinity": "colliding-affinity" },
    );
    await requestAs(app, "B").createResponse(
      {},
      { "x-session-affinity": "colliding-affinity" },
    );

    const sessionIds = providerExecute.mock.calls.map(([input]) => input.sessionId);
    expect(new Set(sessionIds).size).toBe(2);
    expect(sessionIds).not.toContain("colliding-affinity");
  });

  it("gives consumers with distinct affinity IDs distinct provider sessions", async () => {
    const app = createIsolatedApp();
    providerExecute.mockClear();
    await requestAs(app, "A").createResponse(
      {},
      { "x-session-affinity": "affinity-A" },
    );
    await requestAs(app, "B").createResponse(
      {},
      { "x-session-affinity": "affinity-B" },
    );

    const sessionIds = providerExecute.mock.calls.map(([input]) => input.sessionId);
    expect(new Set(sessionIds).size).toBe(2);
  });

  it("keeps concurrent operations of the same consumer correctly associated", async () => {
    const app = createIsolatedApp();
    const consumerA = requestAs(app, "A");
    const [first, second] = await Promise.all([
      consumerA.createResponse({ input: "concurrent-1" }),
      consumerA.createResponse({ input: "concurrent-2" }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.id).not.toBe(second.body.id);
    const storedFirst = services.responseStore.get(String(first.body.id));
    const storedSecond = services.responseStore.get(String(second.body.id));
    expect(storedFirst?.ownerPrincipal).toBe(consumerPrincipalA);
    expect(storedSecond?.ownerPrincipal).toBe(consumerPrincipalA);

    const readFirst = await consumerA.get(`/v1/responses/${String(first.body.id)}`);
    const readSecond = await consumerA.get(`/v1/responses/${String(second.body.id)}`);
    expect(readFirst.status).toBe(200);
    expect(readSecond.status).toBe(200);

    services.responseStore.delete(String(first.body.id));
    services.responseStore.delete(String(second.body.id));
  });

  it("does not release legacy owner-less Responses to any consumer", async () => {
    const app = createIsolatedApp();
    const legacyId = "resp_legacy_ownerless";
    seedResponse(legacyId, undefined, "legacy synthetic payload");
    try {
      for (const principal of ["A", "B"] as const) {
        const consumer = requestAs(app, principal);
        const read = await consumer.get(`/v1/responses/${legacyId}`);
        expect(read.status).toBe(404);
        expect(read.body).toEqual(notFoundPayload);
      }
      expect(services.responseStore.has(legacyId)).toBe(true);

      const localApp = buildApp({
        HOST: "127.0.0.1",
        GATEWAY_API_TOKEN: undefined,
      });
      const localRead = await request(localApp).get(`/v1/responses/${legacyId}`);
      expect(localRead.status).toBe(404);
      expect(localRead.body).toEqual(notFoundPayload);
    } finally {
      services.responseStore.delete(legacyId);
    }
  });

  it("keeps unauthenticated resource access rejected by the gateway", async () => {
    const app = createIsolatedApp();
    const created = await createResponseFor("A");
    try {
      const noAuth = await request(app).get(`/v1/responses/${created.id}`);
      expect(noAuth.status).toBe(401);
      expect(noAuth.body.error.message).toBe("Missing or invalid gateway API key");

      const invalidToken = await request(app)
        .get(`/v1/responses/${created.id}`)
        .set("X-Gateway-API-Key", "synthetic-invalid-gateway-token");
      expect(invalidToken.status).toBe(401);
      expect(invalidToken.body.error.message).toBe(
        "Missing or invalid gateway API key",
      );
      expect(invalidToken.body).toEqual(noAuth.body);
    } finally {
      services.responseStore.delete(created.id);
    }
  });

  it("does not expose principal identifiers in responses or logs", async () => {
    let emittedLogs = "";
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        emittedLogs += chunk.toString("utf8");
        callback();
      },
    });
    setLogger(createLogger({ destination, level: "info" }));
    const app = createIsolatedApp();
    const consumerA = requestAs(app, "A");
    const created = await createResponseFor("A");
    try {
      const read = await consumerA.get(`/v1/responses/${created.id}`);
      const serialized = JSON.stringify(read.body);
      expect(serialized).not.toContain(consumerPrincipalA);
      expect(serialized).not.toContain(consumerPrincipalB);
      expect(serialized).not.toContain(LOCAL_PRINCIPAL);
      await consumerA.createResponse({});
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(emittedLogs).not.toContain(consumerPrincipalA);
      expect(emittedLogs).not.toContain(consumerTokenA);
    } finally {
      services.responseStore.delete(created.id);
    }
    setLogger(createLogger({ level: "silent" }));
  });
});
