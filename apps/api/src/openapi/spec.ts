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
      "Local OpenAI-compatible API for Cursor and Google Antigravity providers. Use Authorize to set gateway and provider credentials before trying protected routes.",
    version: "1.0.0",
  },
  servers: [
    { url: "/", description: "Same host and port as this gateway (matches /docs)" },
  ],
  tags: [
    { name: "Meta", description: "Service metadata and health" },
    { name: "Models", description: "Composer and agent model catalog" },
    { name: "Chat", description: "Chat Completions API" },
    { name: "Completions", description: "Legacy completions API" },
    { name: "Responses", description: "OpenAI Responses API subset" },
    {
      name: "Antigravity",
      description:
        "Google Antigravity OAuth and auth status under `/v1/providers/antigravity/auth`. The gateway still serves the same routes at `/v1/antigravity/auth/*` for backward compatibility. To clear persisted gateway session files under SESSION_STORAGE_PATH, use **Runtime** → `POST /v1/runtime/sessions/clear` (that route does not remove OAuth files under `~/.gemini` or `~/.config/antigravity`).",
    },
    {
      name: "Runtime",
      description:
        "Session store maintenance (namespaces under SESSION_STORAGE_PATH, e.g. cursor and antigravity)",
    },
  ],
  components: {
    securitySchemes: {
      GatewayApiKey: {
        type: "apiKey",
        in: "header",
        name: "X-Gateway-API-Key",
        description:
          "Gateway consumer credential (required when configured or on non-loopback bind).",
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
      AntigravityAuthStartRequest: {
        type: "object",
        properties: {
          redirectUri: {
            type: "string",
            description: "Optional OAuth redirect URI",
            example: "https://antigravity.google/oauth-callback",
          },
        },
      },
      AntigravityAuthStartResponse: {
        type: "object",
        required: ["operationId", "status", "authUrl", "state", "expiresAt"],
        properties: {
          operationId: { type: "string", format: "uuid" },
          status: {
            type: "string",
            enum: ["pending", "completed", "failed", "expired"],
          },
          authUrl: { type: "string" },
          state: { type: "string" },
          expiresAt: { type: "string", format: "date-time" },
        },
      },
      AntigravityAuthCallbackRequest: {
        type: "object",
        required: ["state", "code"],
        properties: {
          state: { type: "string" },
          code: { type: "string" },
          error: { type: "string" },
          error_description: { type: "string" },
        },
      },
      AntigravityAuthCallbackResponse: {
        type: "object",
        required: ["operationId", "status", "message"],
        properties: {
          operationId: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "completed", "failed", "expired"],
          },
          account: { type: "string", nullable: true },
          message: { type: "string" },
        },
      },
      AntigravityAuthStatusResponse: {
        type: "object",
        required: ["authenticated", "lastCheckedAt", "viabilityGate", "limitations"],
        properties: {
          authenticated: { type: "boolean" },
          account: { type: "string", nullable: true },
          lastCheckedAt: { type: "string", format: "date-time" },
          viabilityGate: {
            type: "string",
            enum: ["SUPPORTED", "PARTIALLY_SUPPORTED", "NOT_SUPPORTED", "UNKNOWN"],
          },
          limitations: {
            type: "array",
            items: { type: "string" },
          },
          activeOperation: {
            type: "object",
            properties: {
              operationId: { type: "string" },
              status: { type: "string" },
              createdAt: { type: "string", format: "date-time" },
              expiresAt: { type: "string", format: "date-time" },
              account: { type: "string", nullable: true },
              error: { type: "string", nullable: true },
            },
          },
        },
      },
      AntigravityAuthOperation: {
        type: "object",
        required: ["operationId", "status", "createdAt", "expiresAt"],
        properties: {
          operationId: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "completed", "failed", "expired"],
          },
          createdAt: { type: "string", format: "date-time" },
          expiresAt: { type: "string", format: "date-time" },
          account: { type: "string", nullable: true },
          error: { type: "string", nullable: true },
        },
      },
      RuntimeSessionsClearRequest: {
        type: "object",
        required: ["namespace"],
        properties: {
          namespace: {
            type: "string",
            enum: ["cursor", "antigravity"],
            description:
              "Provider session namespace to remove from the filesystem session store",
          },
        },
      },
      RuntimeSessionsClearResponse: {
        type: "object",
        required: ["cleared", "namespace"],
        properties: {
          cleared: { type: "boolean", example: true },
          namespace: { type: "string", example: "cursor" },
          mapped_acp_ids_count: {
            type: "integer",
            description:
              "Antigravity only: distinct ACP session ids found in the gateway session map before disk clear",
            minimum: 0,
          },
          listed_acp_sessions_count: {
            type: "integer",
            description:
              "Antigravity only: sessions returned by ACP session/list before closing",
            minimum: 0,
          },
          acp_sessions_closed: {
            type: "integer",
            description:
              "Antigravity only: distinct ACP sessions closed via session/close",
            minimum: 0,
          },
          acp_close_failures: {
            type: "integer",
            description:
              "Antigravity only: close attempts that failed or timed out",
            minimum: 0,
          },
          warnings: {
            type: "array",
            items: { type: "string" },
            description:
              "Antigravity only: non-fatal issues (timeouts, RPC errors)",
          },
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
          "404": {
            description: "Unknown model",
            content: { "application/json": { schema: errorResponse } },
          },
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
          "401": {
            description: "Missing credentials",
            content: { "application/json": { schema: errorResponse } },
          },
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
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: errorResponse } },
          },
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
          "401": {
            description: "Unauthorized",
            content: { "application/json": { schema: errorResponse } },
          },
        },
      },
    },
    "/v1/responses/input_tokens": {
      post: {
        tags: ["Responses"],
        summary: "Estimate input tokens",
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { description: "Token estimate" } },
      },
    },
    "/v1/responses/compact": {
      post: {
        tags: ["Responses"],
        summary: "Compact transcript",
        requestBody: {
          content: { "application/json": { schema: { type: "object" } } },
        },
        responses: { "200": { description: "Compact result" } },
      },
    },
    "/v1/responses/{id}": {
      get: {
        tags: ["Responses"],
        summary: "Get stored response",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Stored response" },
          "404": {
            description: "Not found",
            content: { "application/json": { schema: errorResponse } },
          },
        },
      },
      delete: {
        tags: ["Responses"],
        summary: "Delete stored response",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": { description: "Deleted" },
          "404": { description: "Not found" },
        },
      },
    },
    "/v1/responses/{id}/input_items": {
      get: {
        tags: ["Responses"],
        summary: "List input items",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "200": { description: "Input item list" } },
      },
    },
    "/v1/responses/{id}/cancel": {
      post: {
        tags: ["Responses"],
        summary:
          "Cancel response (background only — currently rejected for local runs)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: { "400": { description: "Not a background response" } },
      },
    },
    "/v1/runtime/sessions/clear": {
      post: {
        tags: ["Runtime"],
        summary: "Clear persisted sessions for a provider namespace",
        description:
          "Deletes all JSON session files for the given namespace under SESSION_STORAGE_PATH (filesystem driver). For antigravity, also attempts to close live ACP sessions via session/close after session/list, then clears gateway caches. Requires gateway authentication when configured. Does not remove Antigravity OAuth files under ~/.gemini or ~/.config/antigravity.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RuntimeSessionsClearRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Namespace cleared",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/RuntimeSessionsClearResponse" },
              },
            },
          },
          "400": {
            description: "Invalid or missing namespace",
            content: { "application/json": { schema: errorResponse } },
          },
          "401": {
            description: "Missing or invalid gateway API key",
            content: { "application/json": { schema: errorResponse } },
          },
        },
      },
    },
    "/v1/providers/antigravity/auth/start": {
      post: {
        tags: ["Antigravity"],
        summary: "Start Antigravity OAuth flow",
        description:
          "Initiates official Google Antigravity OAuth 2.0 PKCE flow, creating an operation and returning the authorization URL.",
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AntigravityAuthStartRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Auth operation started successfully",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AntigravityAuthStartResponse" },
              },
            },
          },
          "401": {
            description: "Unauthorized gateway key",
            content: { "application/json": { schema: errorResponse } },
          },
        },
      },
    },
    "/v1/providers/antigravity/auth/callback": {
      get: {
        tags: ["Antigravity"],
        summary: "Handle OAuth callback via redirect / query parameters",
        description: "Receives code, state or error from identity provider callback.",
        parameters: [
          { name: "state", in: "query", required: true, schema: { type: "string" } },
          { name: "code", in: "query", schema: { type: "string" } },
          { name: "error", in: "query", schema: { type: "string" } },
          { name: "error_description", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Auth operation completed successfully",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AntigravityAuthCallbackResponse",
                },
              },
            },
          },
          "400": {
            description: "Invalid state, expired operation, or authorization denied",
            content: { "application/json": { schema: errorResponse } },
          },
          "401": {
            description: "Unauthorized gateway key",
            content: { "application/json": { schema: errorResponse } },
          },
        },
      },
      post: {
        tags: ["Antigravity"],
        summary: "Complete OAuth authorization via JSON payload",
        description:
          "Programmatically completes an auth operation using state and authorization code from your OAuth client (e.g. control plane or Go gateway).",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/AntigravityAuthCallbackRequest" },
            },
          },
        },
        responses: {
          "200": {
            description: "Auth operation completed successfully",
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/AntigravityAuthCallbackResponse",
                },
              },
            },
          },
          "400": {
            description: "Invalid state, expired operation, or authorization denied",
            content: { "application/json": { schema: errorResponse } },
          },
          "401": {
            description: "Unauthorized gateway key",
            content: { "application/json": { schema: errorResponse } },
          },
        },
      },
    },
    "/v1/providers/antigravity/auth/status": {
      get: {
        tags: ["Antigravity"],
        summary: "Get Antigravity authentication status and viability gate",
        description:
          "Returns whether the local Antigravity environment is authenticated, active account, viability gate classification, and documented limitations without exposing secrets.",
        responses: {
          "200": {
            description: "Authentication status report",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AntigravityAuthStatusResponse" },
              },
            },
          },
          "401": {
            description: "Unauthorized gateway key",
            content: { "application/json": { schema: errorResponse } },
          },
        },
      },
    },
    "/v1/providers/antigravity/auth/operations/{operationId}": {
      get: {
        tags: ["Antigravity"],
        summary: "Retrieve auth operation status by ID",
        parameters: [
          {
            name: "operationId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Auth operation summary",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/AntigravityAuthOperation" },
              },
            },
          },
          "404": {
            description: "Operation not found",
            content: { "application/json": { schema: errorResponse } },
          },
          "401": {
            description: "Unauthorized gateway key",
            content: { "application/json": { schema: errorResponse } },
          },
        },
      },
    },
  },
};
