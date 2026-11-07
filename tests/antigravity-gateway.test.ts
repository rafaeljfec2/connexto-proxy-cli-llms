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

/** Real 1x1 transparent PNG (89 50 4E 47 magic bytes). */
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/** Minimal sniffable JPEG payload (FF D8 FF magic bytes). */
const JPEG_BYTES_BASE64 = Buffer.from(
  new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
).toString("base64");

const GIF_BASE64 = Buffer.from("GIF89a01020304", "ascii").toString("base64");

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

  it("routes a single data-URL image through the executor as a normalized image", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const response = await request(app)
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
                image_url: {
                  url: `data:image/png;base64,${PNG_1X1_BASE64}`,
                },
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]).toMatchObject({
      model: antigravityModel,
      message: expect.stringContaining("Describe this"),
      images: [{ mimeType: "image/png", data: PNG_1X1_BASE64 }],
    });
  });

  it("keeps tools explicitly rejected for Antigravity", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
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

    expect(tools.status).toBe(400);
    expect(executedInputs).toHaveLength(0);
  });

  it("rejects invalid Antigravity image payloads without executing a provider", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const invalidBase64 = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: antigravityModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,QUJD***" },
              },
            ],
          },
        ],
      });
    const wrongMime = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: antigravityModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/gif;base64,${GIF_BASE64}`,
                },
              },
            ],
          },
        ],
      });
    const protectedAddress = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: antigravityModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "http://169.254.169.254/latest/meta-data/" },
              },
            ],
          },
        ],
      });

    expect(invalidBase64.status).toBe(400);
    expect(wrongMime.status).toBe(400);
    expect(protectedAddress.status).toBe(400);
    expect(executedInputs).toHaveLength(0);
  });

  it("rejects Antigravity requests with too many images", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: "Many images" },
    ];
    for (let index = 0; index < 10; index += 1) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${PNG_1X1_BASE64}` },
      });
    }

    const response = await request(app)
      .post("/v1/chat/completions")
      .send({ model: antigravityModel, messages: [{ role: "user", content }] });

    expect(response.status).toBe(400);
    expect(executedInputs).toHaveLength(0);
  });

  it("routes text+image and multiple-image prompts with normalized order", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const response = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: antigravityModel,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Compare these" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${PNG_1X1_BASE64}` },
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${JPEG_BYTES_BASE64}`,
                },
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]?.images).toEqual([
      { mimeType: "image/png", data: PNG_1X1_BASE64 },
      { mimeType: "image/jpeg", data: JPEG_BYTES_BASE64 },
    ]);
  });

  it("streams an Antigravity image request through the existing SSE contract", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const response = await request(app)
      .post("/v1/chat/completions")
      .send({
        model: antigravityModel,
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this in a stream" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${PNG_1X1_BASE64}` },
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.text).toContain("data:");
    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]?.images).toEqual([
      { mimeType: "image/png", data: PNG_1X1_BASE64 },
    ]);
  });

  it("accepts Responses API input_image data URLs for Antigravity", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
    const response = await request(app)
      .post("/v1/responses")
      .send({
        model: antigravityModel,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: "What is this?" },
              {
                type: "input_image",
                image_url: `data:image/png;base64,${PNG_1X1_BASE64}`,
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(executedInputs).toHaveLength(1);
    expect(executedInputs[0]?.images).toEqual([
      { mimeType: "image/png", data: PNG_1X1_BASE64 },
    ]);
  });

  it("keeps Cursor image requests unchanged", async () => {
    const app = buildApp({ HOST: "127.0.0.1" });
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
    const response = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer cursor-test-key")
      .send({
        model: "composer-2.5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${PNG_1X1_BASE64}` },
              },
            ],
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(executedInputs.at(-1)).toMatchObject({
      model: "composer-2.5",
      credential: { type: "api_key", value: "cursor-test-key" },
    });
    expect(executedInputs.at(-1)?.images).toBeUndefined();
  });
});
