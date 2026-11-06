export interface CloudCodeQuotaInfo {
  readonly remainingFraction?: number;
  readonly resetTime?: string;
  readonly [key: string]: unknown;
}

export interface CloudCodeModelDetails {
  readonly displayName?: string;
  readonly quotaInfo?: CloudCodeQuotaInfo;
  readonly [key: string]: unknown;
}

export interface CloudCodeFetchAvailableModelsResponse {
  readonly models?: Readonly<Record<string, CloudCodeModelDetails>>;
  readonly [key: string]: unknown;
}

export interface CloudCodeTierInfo {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly upgradeSubscriptionUri?: string;
  readonly upgradeSubscriptionText?: string;
  readonly upgradeSubscriptionType?: string;
  readonly [key: string]: unknown;
}

export interface CloudCodeLoadCodeAssistResponse {
  readonly currentTier?: CloudCodeTierInfo;
  readonly paidTier?: CloudCodeTierInfo;
  readonly allowedTiers?: readonly CloudCodeTierInfo[];
  readonly cloudaicompanionProject?: string;
  readonly gcpManaged?: boolean;
  readonly upgradeSubscriptionUri?: string;
  readonly [key: string]: unknown;
}

export interface AntigravityUsageServiceOptions {
  /** Primary upstream endpoint for Google Cloud Code internal PA. */
  readonly endpoint?: string;
  /** Fallback endpoint if primary is unreachable or configured. */
  readonly fallbackEndpoint?: string;
  /** Custom token resolver for testing or custom credential paths. */
  readonly tokenResolver?: () => Promise<string | undefined>;
  /** Custom account email detector. */
  readonly accountDetector?: () => Promise<string | undefined>;
  /** Request timeout in milliseconds (defaults to 10,000ms). */
  readonly timeoutMs?: number;
  /** Custom User-Agent header (defaults to "Antigravity/1.5.2"). */
  readonly userAgent?: string;
  /** Test seam to inject custom fetch implementation. */
  readonly fetchFn?: typeof fetch;
}

