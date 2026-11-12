/** Default dashboard used only by usage collect (not auth login). */
export const DEFAULT_COLLECT_DASHBOARD_URL = "https://cursor.com/dashboard";

/** Primary quota endpoint (session cookies from cursor.com OAuth). */
export const DEFAULT_USAGE_STATUS_SUFFIX = "/api/usage-summary";

export const DEFAULT_USAGE_ANALYTICS_SUFFIX =
  "/api/dashboard/get-current-period-usage";

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

export interface CursorProductWeeklyUsage {
  readonly product: string;
  readonly used_cents: number;
  readonly used_usd: number;
  readonly used_percent?: number;
}

export function normalizeCursorUsagePayload(
  usageStatus: unknown,
  analytics?: unknown,
  prepaidBilling?: unknown,
): Record<string, unknown> {
  const root =
    usageStatus !== null && typeof usageStatus === "object"
      ? (usageStatus as Record<string, unknown>)
      : {};

  // Support envelope payload { usageStatus, prepaid, analytics }
  const status: Record<string, unknown> =
    root.usageStatus !== undefined && typeof root.usageStatus === "object"
      ? (root.usageStatus as Record<string, unknown>)
      : root;

  const prepaid: Record<string, unknown> | undefined =
    prepaidBilling !== undefined && typeof prepaidBilling === "object"
      ? (prepaidBilling as Record<string, unknown>)
      : root.prepaid !== undefined && typeof root.prepaid === "object"
        ? (root.prepaid as Record<string, unknown>)
        : undefined;

  const resolvedAnalytics =
    analytics ?? (root.analytics !== undefined ? root.analytics : undefined);

  const weekly = readRecord(status.weeklyIncludedUsage);
  let usedCents = readNumber(weekly?.usedCents);
  let budgetCents = readNumber(weekly?.budgetCents);

  const individual = readRecord(status.individualUsage);
  const planUsage = readRecord(individual?.plan);
  if (usedCents === undefined) {
    usedCents = readNumber(planUsage?.used);
  }
  if (budgetCents === undefined) {
    budgetCents = readNumber(planUsage?.limit);
  }
  const period = readRecord(status.currentPeriod);
  if (usedCents === undefined) {
    usedCents = readNumber(period?.usedCents);
  }
  if (budgetCents === undefined) {
    budgetCents = readNumber(period?.limitCents);
  }

  const monthly = readRecord(status.monthlyUsage);
  if (usedCents === undefined) {
    usedCents = readNumber(monthly?.usedCents);
  }

  if (usedCents === undefined && prepaid !== undefined) {
    usedCents = readNumber(prepaid.spentThisMonthCents ?? prepaid.spentCents);
  }

  const result: Record<string, unknown> = {
    currency: "USD",
    raw_usage_status: status,
  };

  const availability = readString(status.availability);
  if (availability !== undefined) {
    result.usage_availability = availability;
  }

  const weeklyStatus = readRecord(status.weeklyIncludedStatus);
  const weeklyIncludedStatus = readString(weeklyStatus?.status);
  if (weeklyIncludedStatus !== undefined) {
    result.weekly_included_status = weeklyIncludedStatus;
  }

  if (usedCents !== undefined) {
    result.total_usage = usedCents / 100;
  }
  if (budgetCents !== undefined) {
    result.total_credits = budgetCents / 100;
  }

  const periodStart = readString(weekly?.periodStart);
  if (periodStart !== undefined) {
    result.weekly_period_start = periodStart;
  }

  const resetsAt = readString(weekly?.resetsAt ?? status.resetsAt);
  if (resetsAt !== undefined) {
    result.weekly_resets_at = resetsAt;
  }

  const resetCounter = readNumber(weekly?.resetCounter);
  if (resetCounter !== undefined) {
    result.weekly_reset_counter = resetCounter;
  }

  if (usedCents !== undefined && budgetCents !== undefined && budgetCents > 0) {
    result.weekly_used_percent = (usedCents / budgetCents) * 100;
  }

  const byProduct = extractWeeklyUsageByProduct(
    status.weeklyIncludedUsageByProduct,
    budgetCents,
  );
  if (byProduct.length > 0) {
    result.weekly_usage_by_product = byProduct;
  }

  applyMonthlyUsage(result, monthly);

  if (prepaid !== undefined) {
    result.raw_prepaid_billing = prepaid;
    const availableCents = readNumber(prepaid.availableCents);
    if (availableCents !== undefined) {
      result.prepaid_available_credits = availableCents / 100;
    }
    const spentThisMonthCents = readNumber(prepaid.spentThisMonthCents ?? prepaid.spentCents);
    if (spentThisMonthCents !== undefined && result.monthly_spent === undefined) {
      result.monthly_spent = spentThisMonthCents / 100;
    }
    const fundedCents = readNumber(prepaid.fundedCents);
    if (fundedCents !== undefined) {
      result.prepaid_funded = fundedCents / 100;
    }
  }

  if (resolvedAnalytics !== null && resolvedAnalytics !== undefined) {
    result.raw_analytics = resolvedAnalytics;
    const summary = summarizeAnalytics(resolvedAnalytics);
    if (summary !== undefined) {
      result.analytics_agent_requests_total = summary;
    }
  }

  return result;
}

function applyMonthlyUsage(
  result: Record<string, unknown>,
  monthly: Record<string, unknown> | undefined,
): void {
  if (monthly === undefined) {
    return;
  }
  const usedCents = readNumber(monthly.usedCents);
  if (usedCents !== undefined) {
    const usedUsd = usedCents / 100;
    result.monthly_additional_usage = usedUsd;
    result.monthly_spent = usedUsd;
  }
  const limitCents = readNumber(monthly.limitCents);
  if (limitCents !== undefined) {
    result.monthly_limit = limitCents / 100;
  }
  const creditsUsedCents = readNumber(monthly.creditsUsedCents);
  if (creditsUsedCents !== undefined) {
    result.monthly_credits_used = creditsUsedCents / 100;
  }
  const additionalUsageOff = readBoolean(monthly.additionalUsageOff);
  if (additionalUsageOff !== undefined) {
    result.monthly_additional_usage_off = additionalUsageOff;
  }
  const periodStart = readString(monthly.periodStart);
  if (periodStart !== undefined) {
    result.monthly_period_start = periodStart;
  }
  const resetsAt = readString(monthly.resetsAt);
  if (resetsAt !== undefined) {
    result.monthly_resets_at = resetsAt;
  }
}

function extractWeeklyUsageByProduct(
  raw: unknown,
  budgetCents: number | undefined,
): CursorProductWeeklyUsage[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: CursorProductWeeklyUsage[] = [];
  for (const entry of raw) {
    const row = readRecord(entry);
    const product = readString(row?.product)?.trim();
    const cents = readNumber(row?.cents ?? row?.usedCents);
    if (product === undefined || product.length === 0 || cents === undefined) {
      continue;
    }
    const item: CursorProductWeeklyUsage = {
      product,
      used_cents: cents,
      used_usd: cents / 100,
      ...(budgetCents !== undefined && budgetCents > 0
        ? { used_percent: (cents / budgetCents) * 100 }
        : {}),
    };
    items.push(item);
  }
  return items;
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

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  return undefined;
}
