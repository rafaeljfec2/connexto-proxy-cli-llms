import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLECT_DASHBOARD_URL,
  normalizeCursorUsagePayload,
  resolveCollectApiUrl,
} from "../src/usage-normalize.js";

describe("resolveCollectApiUrl", () => {
  it("joins status path onto collect dashboard host", () => {
    expect(
      resolveCollectApiUrl(
        DEFAULT_COLLECT_DASHBOARD_URL,
        undefined,
        "/api/usage-summary",
      ),
    ).toBe("https://cursor.com/dashboard/api/usage-summary");
  });

  it("prefers explicit override URL", () => {
    expect(
      resolveCollectApiUrl(
        DEFAULT_COLLECT_DASHBOARD_URL,
        "https://example.test/custom",
        "/ignored",
      ),
    ).toBe("https://example.test/custom");
  });
});

describe("normalizeCursorUsagePayload", () => {
  it("maps weekly included cents to USD totals", () => {
    const normalized = normalizeCursorUsagePayload({
      weeklyIncludedUsage: {
        usedCents: 4168,
        budgetCents: 4615,
      },
      resetsAt: "2026-11-09T21:45:07.488Z",
    });

    expect(normalized.total_usage).toBe(41.68);
    expect(normalized.total_credits).toBe(46.15);
    expect(normalized.currency).toBe("USD");
    expect(normalized.weekly_resets_at).toBe("2026-11-09T21:45:07.488Z");
    expect(normalized.weekly_used_percent).toBeCloseTo(90.31, 1);
  });

  it("handles nested weekly resetsAt and prepaid billing", () => {
    const normalized = normalizeCursorUsagePayload(
      {
        weeklyIncludedUsage: {
          usedCents: 4616,
          budgetCents: 4615,
          resetsAt: "2026-11-09T21:45:07.488Z",
        },
        monthlyUsage: {
          usedCents: 582,
        },
      },
      undefined,
      {
        billingMode: "PREPAID_BILLING_MODE_PREPAID",
        availableCents: "419",
        fundedCents: "1000",
        spentThisMonthCents: "582",
      },
    );

    expect(normalized.total_usage).toBe(46.16);
    expect(normalized.total_credits).toBe(46.15);
    expect(normalized.weekly_resets_at).toBe("2026-11-09T21:45:07.488Z");
    expect(normalized.prepaid_available_credits).toBe(4.19);
    expect(normalized.monthly_spent).toBe(5.82);
    expect(normalized.prepaid_funded).toBe(10);
  });

  it("supports composite envelope { usageStatus, prepaid, analytics }", () => {
    const envelope = {
      usageStatus: {
        weeklyIncludedUsage: {
          usedCents: 4616,
          budgetCents: 4615,
          resetsAt: "2026-11-09T21:45:07.488Z",
        },
      },
      prepaid: {
        availableCents: "419",
        spentThisMonthCents: "582",
      },
      analytics: {
        dailyMetrics: [{ agentRequests: 42 }],
      },
    };

    const normalized = normalizeCursorUsagePayload(envelope);
    expect(normalized.total_usage).toBe(46.16);
    expect(normalized.total_credits).toBe(46.15);
    expect(normalized.weekly_resets_at).toBe("2026-11-09T21:45:07.488Z");
    expect(normalized.prepaid_available_credits).toBe(4.19);
    expect(normalized.analytics_agent_requests_total).toBe(42);
  });
});
