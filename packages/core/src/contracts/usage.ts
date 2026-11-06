export type ProviderUsageStatus =
  "available" | "unsupported" | "unauthenticated" | "error";

export type QuotaNature = "quota" | "usage" | "rate_limit";

export interface ProviderQuotaMetric {
  readonly id: string;
  readonly name?: string | null;
  readonly nature: QuotaNature;
  readonly used?: number | null;
  readonly limit?: number | null;
  readonly remaining?: number | null;
  readonly percentage?: number | null;
  readonly unit?: string | null;
  readonly cycle?: string | null;
  readonly reset_at?: string | null;
  readonly reported_at?: string | null;
  readonly scope?: string | null;
  readonly remaining_fraction?: number | null;
  readonly raw?: Readonly<Record<string, unknown>> | null;
}

export interface ProviderAccountUsageInfo {
  readonly id?: string | null;
  readonly email?: string | null;
  readonly tier?: string | null;
  readonly tier_name?: string | null;
  readonly project?: string | null;
  readonly gcp_managed?: boolean | null;
  readonly [key: string]: unknown;
}

export interface ProviderUsageError {
  readonly code: string;
  readonly message: string;
}

export interface ProviderUsageSnapshot {
  readonly provider: string;
  readonly status: ProviderUsageStatus;
  readonly source: string;
  readonly account: ProviderAccountUsageInfo | null;
  readonly quotas: readonly ProviderQuotaMetric[];
  readonly reported_at: string | null;
  readonly fetched_at: string;
  readonly error?: ProviderUsageError | null;
}

export interface ProviderUsageService {
  readonly providerId: string;
  getUsage(options?: { readonly signal?: AbortSignal }): Promise<ProviderUsageSnapshot>;
}
