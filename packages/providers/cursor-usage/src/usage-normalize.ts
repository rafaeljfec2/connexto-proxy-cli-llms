/** Default dashboard used only by usage collect (not auth login). */
export const DEFAULT_COLLECT_DASHBOARD_URL = "https://grok.com/dashboard";

export const DEFAULT_USAGE_STATUS_SUFFIX =
  "/api/dashboard/v2/usage-status?scope=user";

export const DEFAULT_USAGE_ANALYTICS_SUFFIX = "/api/dashboard/get-user-analytics";

export function resolveCollectApiUrl(
  dashboardUrl: string,
  explicitUrl: string | undefined,
  pathSuffix: string,
): string {
  const explicit = explicitUrl?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const base = dashboardUrl.replace(/\/$/, "");
  return `${base}${pathSuffix}`;
}

export function normalizeCursorUsagePayload(
  usageStatus: unknown,
  analytics?: unknown,
): Record<string, unknown> {
  const status =
    usageStatus !== null && typeof usageStatus === "object"
      ? (usageStatus as Record<string, unknown>)
      : {};

  const weekly = readRecord(status.weeklyIncludedUsage);
  const usedCents = readNumber(weekly?.usedCents);
  const budgetCents = readNumber(weekly?.budgetCents);

  const result: Record<string, unknown> = {
    currency: "USD",
    raw_usage_status: status,
  };

  if (usedCents !== undefined) {
    result.total_usage = usedCents / 100;
  }
  if (budgetCents !== undefined) {
    result.total_credits = budgetCents / 100;
  }

  const resetsAt = readString(status.resetsAt);
  if (resetsAt !== undefined) {
    result.weekly_resets_at = resetsAt;
  }

  if (usedCents !== undefined && budgetCents !== undefined && budgetCents > 0) {
    result.weekly_used_percent = (usedCents / budgetCents) * 100;
  }

  if (analytics !== null && analytics !== undefined) {
    result.raw_analytics = analytics;
    const summary = summarizeAnalytics(analytics);
    if (summary !== undefined) {
      result.analytics_agent_requests_total = summary;
    }
  }

  return result;
}

function summarizeAnalytics(analytics: unknown): number | undefined {
  if (analytics === null || typeof analytics !== "object") {
    return undefined;
  }
  const root = analytics as Record<string, unknown>;
  const metrics = root.dailyMetrics;
  if (!Array.isArray(metrics)) {
    return undefined;
  }
  let total = 0;
  for (const entry of metrics) {
    const row = readRecord(entry);
    const requests = readNumber(row?.agentRequests);
    if (requests !== undefined) {
      total += requests;
    }
  }
  return total > 0 ? total : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value;
  }
  return undefined;
}
