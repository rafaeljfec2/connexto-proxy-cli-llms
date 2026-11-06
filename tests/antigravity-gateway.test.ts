import type { AgentExecutionInput, AgentProvider } from "@agent-runtime-gateway/core";
import { buildApp } from "@agent-runtime-gateway/api";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getGatewayServices,
  resetGatewayServicesForTest,
} from "../apps/api/src/services/gateway.js";
import {
  createCompletedRun,
  createStubProvider,
} from "../packages/core/tests/helpers/stub-provider.js";

interface ProviderRegistryAccess {
  readonly router: {
    readonly registry: {
      readonly providers: Map<string, AgentProvider>;
    };
  };
}

const antigravityModel = "antigravity:gemini-3.8-flash";
const executedInputs: AgentExecutionInput[] = [];
let originalCursorApiKey: string | undefined;

function registerAntigravityStub(): void {
  const services = getGatewayServices();
  const registry = (services.executor as unknown as ProviderRegistryAccess).router
    .registry;
  registry.providers.set(
    "antigravity",
    createStubProvider("antigravity", {
      execute: (input) => {
        executedInputs.push(input);
        return Promise.resolve(
          createCompletedRun(
            "antigravity",
            input.sessionId,
            "Antigravity fixture response",
          ),
        );
      },
    }),
  );
}

function requestBody(model: string = antigravityModel): Record<string, unknown> {
  return {
    model,
    messages: [{ role: "user", content: "Hello from the existing API" }],
  };
}

describe("Antigravity gateway routing", () => {
  beforeEach(() => {
    originalCursorApiKey = process.env["CURSOR_API_KEY"];
    delete process.env["CURSOR_API_KEY"];
    executedInputs.length = 0;
    resetGatewayServicesForTest();
    registerAntigravityStub();
  });

  afterEach(() => {
    resetGatewayServicesForTest();
    if (originalCursorApiKey === undefined) {
      delete process.env["CURSOR_API_KEY"];
    } else {
      process.env["CURSOR_API_KEY"] = originalCursorApiKey;
    }
  });

  it("lists namespaced Antigravity models and resolves their existing metadata route", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });

    const list = await request(app).get("/v1/models");
    const model = await request(app).get(
      `/v1/models/${encodeURIComponent(antigravityModel)}`,
    );

    expect(list.status).toBe(200);
    expect(list.body.data.map((entry: { id: string }) => entry.id)).toContain(
      antigravityModel,
    );
    expect(model.status).toBe(200);
    expect(model.body).toMatchObject({ id: antigravityModel, owned_by: "antigravity" });
  });

  it("registers Antigravity in the shared provider registry", () => {
    expect(getGatewayServices().antigravityProvider.id).toBe("antigravity");
  });

  it("does not forward an unknown Antigravity model to Cursor", async () => {
    const response = await request(buildApp({ HOST: "127.0.0.1" }))
      .post("/v1/chat/completions")
      .send(requestBody("antigravity:unknown-model"));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("model_not_found");
    expect(executedInputs).toHaveLength(0);
  });

  it("routes non-streaming chat requests locally without a Cursor API key", async () => {
    const response = await request(buildApp({ HOST: "127.0.0.1" }))
      .post("/v1/chat/completions")
      .send(requestBody());

    expect(response.status).toBe(200);
    expect(response.body.choices[0].message.content).toBe(
      "Antigravity fixture response",
    );
    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]).toMatchObject({
      model: antigravityModel,
      credential: { type: "local", value: "" },
    });
  });

  it("streams Antigravity chat chunks through the existing SSE contract", async () => {
    const response = await request(buildApp({ HOST: "127.0.0.1" }))
      .post("/v1/chat/completions")
      .send({ ...requestBody(), stream: true });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain("Antigravity fixture response");
    expect(response.text).toContain("[DONE]");
  });

  it.each([
    [
      "legacy completions",
      "/v1/completions",
      { model: antigravityModel, prompt: "Hello" },
    ],
    ["Responses", "/v1/responses", { model: antigravityModel, input: "Hello" }],
    [
      "Responses compact",
      "/v1/responses/compact",
      { model: antigravityModel, input: "Summarize this" },
    ],
  ])(
    "routes %s through the same existing provider registry",
    async (_name, path, body) => {
      const response = await request(buildApp({ HOST: "127.0.0.1" }))
        .post(path)
        .send(body);

      expect(response.status).toBe(200);
      expect(executedInputs.at(-1)).toMatchObject({
        model: antigravityModel,
        credential: { type: "local", value: "" },
      });
    },
  );

  it("keeps gateway authorization enforced for local Antigravity execution", async () => {
    const app = buildApp({
      HOST: "0.0.0.0",
      GATEWAY_API_TOKEN: "gateway-test-token",
    });

    const denied = await request(app).post("/v1/chat/completions").send(requestBody());
    const authorized = await request(app)
      .post("/v1/chat/completions")
      .set("x-gateway-api-key", "gateway-test-token")
      .send(requestBody());

    expect(denied.status).toBe(401);
    expect(authorized.status).toBe(200);
  });

  it("preserves the existing Cursor route and provider credential behavior", async () => {
    const services = getGatewayServices();
    const registry = (services.executor as unknown as ProviderRegistryAccess).router
      .registry;
    registry.providers.set(
      "cursor",
      createStubProvider("cursor", {
        execute: (input) => {
          executedInputs.push(input);
          return Promise.resolve(
            createCompletedRun("cursor", input.sessionId, "Cursor fixture response"),
          );
        },
      }),
    );

    const response = await request(buildApp({ HOST: "127.0.0.1" }))
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer cursor-test-key")
      .send(requestBody("composer-latest"));

    expect(response.status).toBe(200);
    expect(response.body.model).toBe("composer-latest");
    expect(executedInputs.at(-1)).toMatchObject({
      model: "composer-2.5",
      credential: { type: "api_key", value: "cursor-test-key" },
    });
  });

  it("rejects Antigravity image and tool requests without changing Cursor behavior", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const image = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: antigravityModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AA==" },
              },
            ],
          },
        ],
      });
    const tools = await request(app)
      .post("/v1/chat/completions")
      .send({
        ...requestBody(),
        tools: [
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ],
      });

    expect(image.status).toBe(400);
    expect(tools.status).toBe(400);
    expect(executedInputs).toHaveLength(0);
  });
});
