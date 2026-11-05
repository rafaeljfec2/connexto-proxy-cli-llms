const errorResponse = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        message: { type: "string" },
        type: { type: "string" },
        param: { type: "string" },
        code: { type: "string" },
      },
    },
  },
};

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Agent Runtime Gateway",
    description:
      "Local OpenAI-compatible API for Cursor Composer models. Use Authorize to set gateway and Cursor credentials before trying protected routes.",
    version: "1.0.0",
  },
  servers: [{ url: "/", description: "Same host and port as this gateway (matches /docs)" }],
  tags: [
    { name: "Meta", description: "Service metadata and health" },
    { name: "Models", description: "Composer model catalog" },
    { name: "Chat", description: "Chat Completions API" },
    { name: "Completions", description: "Legacy completions API" },
    { name: "Responses", description: "OpenAI Responses API subset" },
  ],
  components: {
    securitySchemes: {
      GatewayApiKey: {
        type: "apiKey",
        in: "header",
        name: "X-Gateway-API-Key",
        description: "Gateway consumer credential (required when configured or on non-loopback bind).",
      },
      CursorBearer: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API key",
        description: "Cursor API key as Bearer token (Authorization header).",
      },
      CursorApiKey: {
        type: "apiKey",
        in: "header",
        name: "x-api-key",
        description: "Cursor API key alternative to Authorization Bearer.",
      },
    },
    schemas: {
      ErrorResponse: errorResponse,
      ChatCompletionRequest: {
        type: "object",
        required: ["model", "messages"],
        properties: {
          model: { type: "string", example: "composer-2.5" },
          messages: {
            type: "array",
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ["system", "user", "assistant"] },
                content: { type: "string" },
              },
            },
          },
          stream: { type: "boolean", default: false },
        },
      },
      ResponsesCreateRequest: {
        type: "object",
        required: ["model", "input"],
        properties: {
          model: { type: "string", example: "composer-2.5" },
          input: {
            description: "String prompt or structured input items",
            oneOf: [{ type: "string" }, { type: "array", items: { type: "object" } }],
          },
          stream: { type: "boolean", default: false },
          store: { type: "boolean" },
          previous_response_id: { type: "string" },
        },
      },
    },
  },
  security: [{ GatewayApiKey: [] }, { CursorBearer: [] }],
  paths: {
    "/health": {
      get: {
        tags: ["Meta"],
        summary: "Health and runtime counters",
        security: [],
        responses: {
          "200": {
            description: "Service is up",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    service: { type: "string" },
                    runtime: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/v1": {
      get: {
        tags: ["Meta"],
        summary: "Service metadata",
        security: [],
        responses: { "200": { description: "Metadata JSON" } },
      },
    },
    "/v1/models": {
      get: {
        tags: ["Models"],
        summary: "List models",
        security: [],
        responses: { "200": { description: "OpenAI-style model list" } },
      },
    },
    "/v1/models/{model}": {
      get: {
        tags: ["Models"],
        summary: "Retrieve model",
        security: [],
        parameters: [
          {
            name: "model",
            in: "path",
            required: true,
            schema: { type: "string", example: "composer-2.5" },
          },
        ],
        responses: {
          "200": { description: "Model object" },
          "404": { description: "Unknown model", content: { "application/json": { schema: errorResponse } } },
        },
      },
    },
    "/v1/chat/completions": {
      post: {
        tags: ["Chat"],
        summary: "Create chat completion",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ChatCompletionRequest" },
            },
          },
        },
        responses: {
          "200": { description: "JSON completion or SSE when stream=true" },
          "401": { description: "Missing credentials", content: { "application/json": { schema: errorResponse } } },
        },
      },
    },
    "/v1/completions": {
      post: {
        tags: ["Completions"],
        summary: "Create legacy completion",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  model: { type: "string" },
                  prompt: { type: "string" },
                  stream: { type: "boolean" },
                },
              },
            },
          },
        },
        responses: {
          "200": { description: "Completion response" },
          "401": { description: "Unauthorized", content: { "application/json": { schema: errorResponse } } },
        },
      },
    },
    "/v1/responses": {
      post: {
        tags: ["Responses"],
        summary: "Create response",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ResponsesCreateRequest" },
            },
          },
        },
        responses: {
          "200": { description: "Response object or SSE stream" },
          "401": { description: "Unauthorized", content: { "application/json": { schema: errorResponse } } },
        },
      },
    },
    "/v1/responses/input_tokens": {
      post: {
        tags: ["Responses"],
        summary: "Estimate input tokens",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Token estimate" } },
      },
    },
    "/v1/responses/compact": {
      post: {
        tags: ["Responses"],
        summary: "Compact transcript",
        requestBody: { content: { "application/json": { schema: { type: "object" } } } },
        responses: { "200": { description: "Compact result" } },
      },
    },
    "/v1/responses/{id}": {
      get: {
        tags: ["Responses"],
        summary: "Get stored response",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Stored response" },
          "404": { description: "Not found", content: { "application/json": { schema: errorResponse } } },
        },
      },
      delete: {
        tags: ["Responses"],
        summary: "Delete stored response",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" }, "404": { description: "Not found" } },
      },
    },
    "/v1/responses/{id}/input_items": {
      get: {
        tags: ["Responses"],
        summary: "List input items",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Input item list" } },
      },
    },
    "/v1/responses/{id}/cancel": {
      post: {
        tags: ["Responses"],
        summary: "Cancel response (background only — currently rejected for local runs)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "400": { description: "Not a background response" } },
      },
    },
  },
};
