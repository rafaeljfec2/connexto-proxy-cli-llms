import type {
  ProviderAccountUsageInfo,
  ProviderQuotaMetric,
  ProviderUsageService,
  ProviderUsageSnapshot,
} from "@agent-runtime-gateway/core";
import {
  AntigravityTokenResolver,
  type AntigravityTokenResolverOptions,
} from "./token-resolver.js";
import type {
  AntigravityUsageServiceOptions,
  CloudCodeFetchAvailableModelsResponse,
  CloudCodeLoadCodeAssistResponse,
  CloudCodeQuotaSummaryBucket,
  CloudCodeQuotaSummaryGroup,
  CloudCodeRetrieveUserQuotaSummaryResponse,
} from "./types.js";

const DEFAULT_CLOUD_CODE_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const DEFAULT_FALLBACK_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "Antigravity/1.5.2";

export class AntigravityUsageService implements ProviderUsageService {
  public readonly providerId = "antigravity";

  private readonly primaryEndpoint: string;
  private readonly fallbackEndpoint: string;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchFn: typeof fetch;
  private readonly tokenResolver: AntigravityTokenResolver;
  private readonly customTokenResolver?: () => Promise<string | undefined>;
  private readonly customAccountDetector?: () => Promise<string | undefined>;

  constructor(
    options: AntigravityUsageServiceOptions & AntigravityTokenResolverOptions = {},
  ) {
    this.primaryEndpoint = options.endpoint ?? DEFAULT_CLOUD_CODE_ENDPOINT;
    this.fallbackEndpoint = options.fallbackEndpoint ?? DEFAULT_FALLBACK_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchFn = options.fetchFn ?? fetch;
    this.customTokenResolver = options.tokenResolver;
    this.customAccountDetector = options.accountDetector;
    this.tokenResolver = new AntigravityTokenResolver({
      homeDir: options.homeDir,
      fetchFn: options.fetchFn,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
    });
  }

  public async getUsage(options?: {
    readonly signal?: AbortSignal;
  }): Promise<ProviderUsageSnapshot> {
    const fetchedAt = new Date().toISOString();

    // 1. Resolve local credentials
    let accessToken: string | undefined;
    let detectedEmail: string | undefined;

    if (this.customTokenResolver) {
      accessToken = await this.customTokenResolver();
      detectedEmail = this.customAccountDetector
        ? await this.customAccountDetector()
        : undefined;
    } else {
      const credentials = await this.tokenResolver.resolveCredentials();
      accessToken = credentials?.accessToken;
      detectedEmail =
        credentials?.email ?? (await this.tokenResolver.detectAccountEmail());
    }

    if (!accessToken) {
      return {
        provider: "antigravity",
        status: "unauthenticated",
        source: "agy",
        account: detectedEmail ? { email: detectedEmail } : null,
        quotas: [],
        reported_at: null,
        fetched_at: fetchedAt,
        error: {
          code: "unauthenticated",
          message: "No active local Antigravity session found.",
        },
      };
    }

    // 2. Fetch models quota and account info from official Cloud Code PA upstream
    try {
      const { modelsResponse, loadCodeAssistResponse, quotaSummaryResponse } =
        await this.fetchUpstreamData(accessToken, options?.signal);

      const quotas = this.parseQuotas(modelsResponse, quotaSummaryResponse);
      const account = this.parseAccount(loadCodeAssistResponse, detectedEmail);

      return {
        provider: "antigravity",
        status: "available",
        source: "agy",
        account,
        quotas,
        reported_at: null,
        fetched_at: fetchedAt,
      };
    } catch (err: unknown) {
      return this.handleUpstreamError(err, detectedEmail, fetchedAt);
    }
  }

  private async fetchUpstreamData(
    accessToken: string,
    callerSignal?: AbortSignal,
  ): Promise<{
    modelsResponse: CloudCodeFetchAvailableModelsResponse;
    loadCodeAssistResponse?: CloudCodeLoadCodeAssistResponse;
    quotaSummaryResponse?: CloudCodeRetrieveUserQuotaSummaryResponse;
  }> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
    };

    // Parallel calls: models, code assist, and quota summary
    const modelsPromise = this.fetchWithFallback<CloudCodeFetchAvailableModelsResponse>(
      "/v1internal:fetchAvailableModels",
      headers,
      combinedSignal,
    );

    const loadCodeAssistPromise =
      this.fetchWithFallback<CloudCodeLoadCodeAssistResponse>(
        "/v1internal:loadCodeAssist",
        headers,
        combinedSignal,
      ).catch(() => undefined);

    const quotaSummaryPromise =
      this.fetchWithFallback<CloudCodeRetrieveUserQuotaSummaryResponse>(
        "/v1internal:retrieveUserQuotaSummary",
        headers,
        combinedSignal,
      ).catch(() => undefined);

    const [modelsResponse, loadCodeAssistResponse, quotaSummaryResponse] =
      await Promise.all([
        modelsPromise,
        loadCodeAssistPromise,
        quotaSummaryPromise,
      ]);

    return {
      modelsResponse,
      loadCodeAssistResponse,
      quotaSummaryResponse,
    };
  }

  private async fetchWithFallback<T>(
    path: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await this.executePost<T>(
        `${this.primaryEndpoint}${path}`,
        headers,
        signal,
      );
    } catch (err) {
      if (this.isFatalAuthOrAbort(err)) {
        throw err;
      }
      // If primary endpoint fails with network error or 5xx, try fallback endpoint
      return await this.executePost<T>(
        `${this.fallbackEndpoint}${path}`,
        headers,
        signal,
      );
    }
  }

  private async executePost<T>(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers,
      body: "{}",
      signal,
    });

    if (response.status === 401 || response.status === 403) {
      throw new AntigravityUpstreamAuthError(
        `Upstream rejected credentials with status ${response.status}`,
      );
    }

    if (!response.ok) {
      throw new AntigravityUpstreamApiError(
        `Upstream returned error status ${response.status}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  private isFatalAuthOrAbort(err: unknown): boolean {
    if (err instanceof AntigravityUpstreamAuthError) return true;
    if (err instanceof Error && err.name === "AbortError") return true;
    if (err instanceof Error && err.name === "TimeoutError") return true;
    return false;
  }

  private parseQuotas(
    response: CloudCodeFetchAvailableModelsResponse,
    summaryResponse?: CloudCodeRetrieveUserQuotaSummaryResponse,
  ): readonly ProviderQuotaMetric[] {
    const quotas: ProviderQuotaMetric[] = [];

    // 1. Process group-level quota buckets from retrieveUserQuotaSummary
    const groups: readonly CloudCodeQuotaSummaryGroup[] =
      summaryResponse?.groups ?? [];
    for (const group of groups) {
      const buckets: readonly CloudCodeQuotaSummaryBucket[] =
        group.buckets ?? [];
      const groupName = group.displayName ?? "Model Group";
      for (const bucket of buckets) {
        const window = bucket.window ?? "limit";
        const remainingFraction =
          typeof bucket.remainingFraction === "number"
            ? bucket.remainingFraction
            : null;
        const resetAt =
          typeof bucket.resetTime === "string" && bucket.resetTime.length > 0
            ? bucket.resetTime
            : null;

        quotas.push({
          id: `group:${groupName}:${window}`,
          name: `${groupName} (${bucket.displayName ?? window})`,
          nature: "rate_limit",
          used: null,
          limit: null,
          remaining: null,
          percentage: null,
          unit: null,
          cycle: window,
          reset_at: resetAt,
          reported_at: null,
          scope: "group",
          remaining_fraction: remainingFraction,
          raw: {
            group: groupName,
            bucketId: bucket.bucketId,
            window: bucket.window,
            description: bucket.description,
          },
        });
      }
    }

    // 2. Process model-level quotas from fetchAvailableModels
    const models = response.models;
    if (models && typeof models === "object") {
      for (const [modelId, details] of Object.entries(models)) {
        if (!details || typeof details !== "object") {
          continue;
        }

        const quotaInfo = details.quotaInfo;
        const remainingFraction =
          typeof quotaInfo?.remainingFraction === "number"
            ? quotaInfo.remainingFraction
            : null;
        const resetAt =
          typeof quotaInfo?.resetTime === "string" && quotaInfo.resetTime.length > 0
            ? quotaInfo.resetTime
            : null;

        quotas.push({
          id: modelId,
          name: details.displayName ?? modelId,
          nature: "rate_limit",
          used: null,
          limit: null,
          remaining: null,
          percentage: null,
          unit: null,
          cycle: null,
          reset_at: resetAt,
          reported_at: null,
          scope: "model",
          remaining_fraction: remainingFraction,
          raw: quotaInfo && typeof quotaInfo === "object" ? { ...quotaInfo } : null,
        });
      }
    }

    return quotas;
  }

  private parseAccount(
    response?: CloudCodeLoadCodeAssistResponse,
    detectedEmail?: string,
  ): ProviderAccountUsageInfo | null {
    if (!response && !detectedEmail) {
      return null;
    }

    const currentTier = response?.currentTier;
    const paidTier = response?.paidTier;

    return {
      email: detectedEmail ?? null,
      tier: currentTier?.id ?? null,
      tier_name: currentTier?.name ?? null,
      project: response?.cloudaicompanionProject ?? null,
      gcp_managed: response?.gcpManaged ?? false,
      upgrade_subscription_uri:
        currentTier?.upgradeSubscriptionUri ?? response?.upgradeSubscriptionUri ?? null,
      paid_tier: paidTier
        ? {
            id: paidTier.id ?? null,
            name: paidTier.name ?? null,
            description: paidTier.description ?? null,
          }
        : null,
    };
  }

  private handleUpstreamError(
    err: unknown,
    detectedEmail: string | undefined,
    fetchedAt: string,
  ): ProviderUsageSnapshot {
    if (err instanceof AntigravityUpstreamAuthError) {
      return {
        provider: "antigravity",
        status: "unauthenticated",
        source: "agy",
        account: detectedEmail ? { email: detectedEmail } : null,
        quotas: [],
        reported_at: null,
        fetched_at: fetchedAt,
        error: {
          code: "unauthenticated",
          message: "Antigravity credentials rejected by upstream.",
        },
      };
    }

    const isTimeout =
      (err instanceof Error && err.name === "TimeoutError") ||
      (err instanceof Error && err.name === "AbortError");

    return {
      provider: "antigravity",
      status: "error",
      source: "agy",
      account: detectedEmail ? { email: detectedEmail } : null,
      quotas: [],
      reported_at: null,
      fetched_at: fetchedAt,
      error: {
        code: isTimeout ? "timeout" : "upstream_error",
        message: isTimeout
          ? "Upstream request timed out."
          : "Failed to fetch usage from upstream provider.",
      },
    };
  }
}

export class AntigravityUpstreamAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AntigravityUpstreamAuthError";
  }
}

export class AntigravityUpstreamApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AntigravityUpstreamApiError";
  }
}
