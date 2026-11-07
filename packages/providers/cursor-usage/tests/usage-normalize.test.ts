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
});
