import { describe, expect, it, vi } from "vitest";
import {
  AntigravityUsageService,
  type CloudCodeFetchAvailableModelsResponse,
  type CloudCodeLoadCodeAssistResponse,
} from "../src/index.js";

const FIXTURE_MODELS_RESPONSE: CloudCodeFetchAvailableModelsResponse = {
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
        remainingFraction: 0.75,
        resetTime: "2026-11-13T19:26:55Z",
      },
    },
    "gemini-zero-quota": {
      displayName: "Exhausted Model",
      quotaInfo: {
        remainingFraction: 0,
        resetTime: "2026-11-08T12:00:00Z",
      },
    },
    "model-without-quota": {
      displayName: "Unmetered Model",
    },
  },
};

const FIXTURE_CODE_ASSIST_RESPONSE: CloudCodeLoadCodeAssistResponse = {
  currentTier: {
    id: "free-tier",
    name: "Antigravity",
    description: "Gemini-powered code suggestions and chat in multiple IDEs",
    upgradeSubscriptionUri: "https://codeassist.google.com/upgrade",
  },
  cloudaicompanionProject: "aicode-consumers",
  gcpManaged: false,
  paidTier: {
    id: "starter-quota",
    name: "Antigravity Starter Quota",
    description: "Antigravity Starter Quota",
  },
};

describe("AntigravityUsageService Unit Test Suite", () => {
  it("parses valid upstream response preserving all fields and zero values", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes(":fetchAvailableModels")) {
        return Promise.resolve(
          new Response(JSON.stringify(FIXTURE_MODELS_RESPONSE), { status: 200 }),
        );
      }
      if (url.includes(":loadCodeAssist")) {
        return Promise.resolve(
          new Response(JSON.stringify(FIXTURE_CODE_ASSIST_RESPONSE), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    });

    const service = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve("mock-access-token"),
      accountDetector: () => Promise.resolve("user@example.com"),
      fetchFn: mockFetch,
    });

    const snapshot = await service.getUsage();

    expect(snapshot.provider).toBe("antigravity");
    expect(snapshot.status).toBe("available");
    expect(snapshot.source).toBe("agy");
    expect(snapshot.fetched_at).toBeDefined();

    // Verify account info
    expect(snapshot.account).toEqual({
      email: "user@example.com",
      tier: "free-tier",
      tier_name: "Antigravity",
      project: "aicode-consumers",
      gcp_managed: false,
      upgrade_subscription_uri: "https://codeassist.google.com/upgrade",
      paid_tier: {
        id: "starter-quota",
        name: "Antigravity Starter Quota",
        description: "Antigravity Starter Quota",
      },
    });

    // Verify quotas count
    expect(snapshot.quotas).toHaveLength(4);

    // Verify zero remainingFraction is preserved
    const zeroModel = snapshot.quotas.find((q) => q.id === "gemini-zero-quota");
    expect(zeroModel).toBeDefined();
    expect(zeroModel?.remaining_fraction).toBe(0);
    expect(zeroModel?.reset_at).toBe("2026-11-08T12:00:00Z");
    expect(zeroModel?.nature).toBe("rate_limit");
    expect(zeroModel?.used).toBeNull();
    expect(zeroModel?.limit).toBeNull();
    expect(zeroModel?.remaining).toBeNull();
    expect(zeroModel?.percentage).toBeNull();

    // Verify model with fraction 1
    const flashModel = snapshot.quotas.find(
      (q) => q.id === "gemini-2.5-flash-thinking",
    );
    expect(flashModel).toBeDefined();
    expect(flashModel?.name).toBe("Gemini 3.5 Flash Lite");
    expect(flashModel?.remaining_fraction).toBe(1);
    expect(flashModel?.reset_at).toBe("2026-11-07T00:26:55Z");
    expect(flashModel?.raw).toEqual({
      remainingFraction: 1,
      resetTime: "2026-11-07T00:26:55Z",
    });

    // Verify model without quotaInfo
    const unmetered = snapshot.quotas.find((q) => q.id === "model-without-quota");
    expect(unmetered).toBeDefined();
    expect(unmetered?.remaining_fraction).toBeNull();
    expect(unmetered?.reset_at).toBeNull();
    expect(unmetered?.raw).toBeNull();
  });

  it("returns unauthenticated status when no local token exists", async () => {
    const service = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve(undefined),
      accountDetector: () => Promise.resolve(undefined),
    });

    const snapshot = await service.getUsage();

    expect(snapshot.status).toBe("unauthenticated");
    expect(snapshot.quotas).toEqual([]);
    expect(snapshot.error?.code).toBe("unauthenticated");
  });

  it("returns unauthenticated status when upstream returns 401", async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      return Promise.resolve(
        new Response(JSON.stringify({ error: "Invalid credentials" }), {
          status: 401,
        }),
      );
    });

    const service = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve("expired-or-revoked-token"),
      accountDetector: () => Promise.resolve("user@example.com"),
      fetchFn: mockFetch,
    });

    const snapshot = await service.getUsage();

    expect(snapshot.status).toBe("unauthenticated");
    expect(snapshot.error?.code).toBe("unauthenticated");
  });

  it("handles upstream 500 error gracefully", async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
    });

    const service = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve("valid-token"),
      accountDetector: () => Promise.resolve("user@example.com"),
      fetchFn: mockFetch,
    });

    const snapshot = await service.getUsage();

    expect(snapshot.status).toBe("error");
    expect(snapshot.error?.code).toBe("upstream_error");
    expect(snapshot.quotas).toEqual([]);
  });

  it("handles timeout error gracefully", async () => {
    const mockFetch = vi.fn().mockImplementation(() => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "TimeoutError";
      return Promise.reject(abortError);
    });

    const service = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve("valid-token"),
      accountDetector: () => Promise.resolve("user@example.com"),
      fetchFn: mockFetch,
    });

    const snapshot = await service.getUsage();

    expect(snapshot.status).toBe("error");
    expect(snapshot.error?.code).toBe("timeout");
  });

  it("handles partial upstream success where loadCodeAssist fails but models succeeds", async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes(":fetchAvailableModels")) {
        return Promise.resolve(
          new Response(JSON.stringify(FIXTURE_MODELS_RESPONSE), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("Service Unavailable", { status: 503 }));
    });

    const service = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve("valid-token"),
      accountDetector: () => Promise.resolve("user@example.com"),
      fetchFn: mockFetch,
    });

    const snapshot = await service.getUsage();

    expect(snapshot.status).toBe("available");
    expect(snapshot.quotas.length).toBeGreaterThan(0);
    expect(snapshot.account?.email).toBe("user@example.com");
    expect(snapshot.account?.tier).toBeNull();
  });

  it("fetches and integrates retrieveUserQuotaSummary group buckets into quotas", async () => {
    const summaryResponse = {
      groups: [
        {
          displayName: "Claude and GPT models",
          buckets: [
            {
              bucketId: "3p-weekly",
              displayName: "Weekly Limit Remaining",
              window: "weekly",
              resetTime: "2026-11-12T00:46:33Z",
              remainingFraction: 0.4772592,
            },
            {
              bucketId: "3p-5h",
              displayName: "Five Hour Limit Remaining",
              window: "5h",
              resetTime: "2026-11-07T05:51:19Z",
              remainingFraction: 1.0,
            },
          ],
        },
      ],
    };

    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes(":fetchAvailableModels")) {
        return Promise.resolve(
          new Response(JSON.stringify(FIXTURE_MODELS_RESPONSE), { status: 200 }),
        );
      }
      if (url.includes(":loadCodeAssist")) {
        return Promise.resolve(
          new Response(JSON.stringify(FIXTURE_CODE_ASSIST_RESPONSE), { status: 200 }),
        );
      }
      if (url.includes(":retrieveUserQuotaSummary")) {
        return Promise.resolve(
          new Response(JSON.stringify(summaryResponse), { status: 200 }),
        );
      }
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    });

    const service = new AntigravityUsageService({
      tokenResolver: () => Promise.resolve("valid-token"),
      accountDetector: () => Promise.resolve("user@example.com"),
      fetchFn: mockFetch,
    });

    const snapshot = await service.getUsage();

    expect(snapshot.status).toBe("available");
    const groupMetrics = snapshot.quotas.filter((q) => q.scope === "group");
    expect(groupMetrics.length).toBe(2);

    const weekly = groupMetrics.find((q) => q.cycle === "weekly");
    expect(weekly).toBeDefined();
    expect(weekly?.remaining_fraction).toBeCloseTo(0.4772592);
    expect(weekly?.reset_at).toBe("2026-11-12T00:46:33Z");

    const fiveHour = groupMetrics.find((q) => q.cycle === "5h");
    expect(fiveHour).toBeDefined();
    expect(fiveHour?.remaining_fraction).toBe(1.0);
    expect(fiveHour?.reset_at).toBe("2026-11-07T05:51:19Z");
  });
});
