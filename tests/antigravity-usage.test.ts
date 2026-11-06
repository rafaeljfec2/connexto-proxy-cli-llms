import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "@agent-runtime-gateway/api";
import {
  AntigravityUsageService,
  type CloudCodeFetchAvailableModelsResponse,
  type CloudCodeLoadCodeAssistResponse,
} from "@agent-runtime-gateway/provider-antigravity";
import {
  initializeGatewayServices,
  resetGatewayServicesForTest,
} from "../apps/api/src/services/gateway.js";

const TEST_GATEWAY_KEY = "test-gateway-key-usage-api";
const USAGE_ENDPOINT = "/v1/providers/antigravity/usage";

const MOCK_MODELS_DATA: CloudCodeFetchAvailableModelsResponse = {
  models: {
    "gemini-2.5-flash-thinking": {
      displayName: "Gemini 3.5 Flash Lite",
      quotaInfo: {
        remainingFraction: 1,
        resetTime: "2026-11-07T00:26:55Z",
      },
    },
    "claude-sonnet-4-6": {
      displayName: "Claude Sonnet 4.6 (Thinking)",
      quotaInfo: {
        remainingFraction: 0.5,
        resetTime: "2026-11-13T19:26:55Z",
      },
    },
  },
};

const MOCK_CODE_ASSIST_DATA: CloudCodeLoadCodeAssistResponse = {
  currentTier: {
    id: "free-tier",
    name: "Antigravity",
    description: "Gemini-powered code suggestions and chat in multiple IDEs",
  },
  cloudaicompanionProject: "aicode-consumers",
  gcpManaged: false,
};

describe("Antigravity Usage HTTP Endpoint Suite", () => {
  it("rejects requests without gateway key when key is configured", async () => {
    resetGatewayServicesForTest();
    const app = buildApp({
      HOST: "0.0.0.0",
      GATEWAY_API_TOKEN: TEST_GATEWAY_KEY,
    });

    const res = await request(app).get(USAGE_ENDPOINT).send();

    expect(res.status).toBe(401);
    expect(res.body.error).toBeDefined();
  });

  it("rejects requests with invalid gateway key", async () => {
    resetGatewayServicesForTest();
    const app = buildApp({
      HOST: "0.0.0.0",
      GATEWAY_API_TOKEN: TEST_GATEWAY_KEY,
    });

    const res = await request(app)
      .get(USAGE_ENDPOINT)
      .set("x-gateway-api-key", "wrong-token")
      .send();

    expect(res.status).toBe(401);
  });

  it("returns 200 with available status and normalized payload on valid gateway key", async () => {
    resetGatewayServicesForTest();

    const mockFetch: typeof fetch = (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.includes(":fetchAvailableModels")) {
        return Promise.resolve(
          new Response(JSON.stringify(MOCK_MODELS_DATA), { status: 200 }),
        );
      }
      if (url.includes(":loadCodeAssist")) {
        return Promise.resolve(
          new Response(JSON.stringify(MOCK_CODE_ASSIST_DATA), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const mockService = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve("mock-secret-access-token-12345"),
      accountDetector: () => Promise.resolve("user@example.com"),
      fetchFn: mockFetch,
    });

    initializeGatewayServices(
      {
        CURSOR_DEFAULT_WORKING_DIRECTORY: "/tmp",
      },
      {
        antigravityUsageService: mockService,
      },
    );

    const app = buildApp({
      HOST: "0.0.0.0",
      GATEWAY_API_TOKEN: TEST_GATEWAY_KEY,
    });

    const res = await request(app)
      .get(USAGE_ENDPOINT)
      .set("x-gateway-api-key", TEST_GATEWAY_KEY)
      .send();

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe("antigravity");
    expect(res.body.status).toBe("available");
    expect(res.body.source).toBe("agy");
    expect(res.body.account?.email).toBe("user@example.com");
    expect(res.body.account?.tier).toBe("free-tier");
    expect(res.body.quotas).toHaveLength(2);

    const modelMetric = res.body.quotas.find(
      (q: { id: string }) => q.id === "gemini-2.5-flash-thinking",
    );
    expect(modelMetric).toBeDefined();
    expect(modelMetric.name).toBe("Gemini 3.5 Flash Lite");
    expect(modelMetric.nature).toBe("rate_limit");
    expect(modelMetric.remaining_fraction).toBe(1);
    expect(modelMetric.reset_at).toBe("2026-11-07T00:26:55Z");
    expect(modelMetric.used).toBeNull();
    expect(modelMetric.limit).toBeNull();
    expect(modelMetric.percentage).toBeNull();

    // Sensitive data check
    const rawResponseBody = JSON.stringify(res.body);
    expect(rawResponseBody).not.toContain("mock-secret-access-token-12345");
  });

  it("returns 503 when local session is unauthenticated", async () => {
    resetGatewayServicesForTest();

    const mockService = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve(undefined),
      accountDetector: () => Promise.resolve(undefined),
    });

    initializeGatewayServices(
      {
        CURSOR_DEFAULT_WORKING_DIRECTORY: "/tmp",
      },
      {
        antigravityUsageService: mockService,
      },
    );

    const app = buildApp({
      HOST: "0.0.0.0",
      GATEWAY_API_TOKEN: TEST_GATEWAY_KEY,
    });

    const res = await request(app)
      .get(USAGE_ENDPOINT)
      .set("x-gateway-api-key", TEST_GATEWAY_KEY)
      .send();

    expect(res.status).toBe(503);
    expect(res.body.provider).toBe("antigravity");
    expect(res.body.status).toBe("unauthenticated");
    expect(res.body.error?.code).toBe("unauthenticated");
  });

  it("returns 502 when upstream provider encounters 500 error", async () => {
    resetGatewayServicesForTest();

    const mockFetch: typeof fetch = () => {
      return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
    };

    const mockService = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve("valid-token-upstream-fails"),
      accountDetector: () => Promise.resolve("user@example.com"),
      fetchFn: mockFetch,
    });

    initializeGatewayServices(
      {
        CURSOR_DEFAULT_WORKING_DIRECTORY: "/tmp",
      },
      {
        antigravityUsageService: mockService,
      },
    );

    const app = buildApp({
      HOST: "0.0.0.0",
      GATEWAY_API_TOKEN: TEST_GATEWAY_KEY,
    });

    const res = await request(app)
      .get(USAGE_ENDPOINT)
      .set("x-gateway-api-key", TEST_GATEWAY_KEY)
      .send();

    expect(res.status).toBe(502);
    expect(res.body.status).toBe("error");
    expect(res.body.error?.code).toBe("upstream_error");
  });
});
