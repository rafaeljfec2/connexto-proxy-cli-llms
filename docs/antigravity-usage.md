# Antigravity Usage API

The Antigravity Usage API provides official consumption and quota metrics for the locally authenticated Google Antigravity account without requiring external OAuth token delivery, manual credential handoffs, or artificial inference prompts.

Endpoint:

```http
GET /v1/providers/antigravity/usage
```

## Authentication & Authorization

- **Gateway Authentication**: Protected by the gateway API key middleware. Requires the `x-gateway-api-key` header when `GATEWAY_API_TOKEN` / `GATEWAY_API_TOKENS` is configured, identical to other mutating and administrative endpoints.
- **Provider Credentials**: Automatically reuses local Google Antigravity credentials stored in `~/.gemini/antigravity-cli/antigravity-oauth-token`, `~/.gemini/jetski-standalone-oauth-token`, or `~/.gemini/oauth_creds.json`.
- **Automatic Token Refresh**: If the local access token is expired or near expiration, the service refreshes it via Google's OAuth endpoint (`https://oauth2.googleapis.com/token`) using the refresh token and persists the renewed access token locally.
- **Zero Client OAuth**: Clients do not provide Google OAuth tokens or Cursor keys in request headers or body.

## Response Contract (Normalized DTO)

```json
{
  "provider": "antigravity",
  "status": "available",
  "source": "agy",
  "account": {
    "email": "user@example.com",
    "tier": "free-tier",
    "tier_name": "Antigravity",
    "project": "aicode-consumers",
    "gcp_managed": false,
    "upgrade_subscription_uri": "https://accounts.google.com/...",
    "paid_tier": {
      "id": "free-tier",
      "name": "Antigravity Starter Quota",
      "description": "Antigravity Starter Quota"
    }
  },
  "quotas": [
    {
      "id": "gemini-2.5-flash-thinking",
      "name": "Gemini 3.5 Flash Lite",
      "nature": "rate_limit",
      "used": null,
      "limit": null,
      "remaining": null,
      "percentage": null,
      "unit": null,
      "cycle": null,
      "reset_at": "2026-11-07T00:26:55Z",
      "reported_at": null,
      "scope": "model",
      "remaining_fraction": 1,
      "raw": {
        "remainingFraction": 1,
        "resetTime": "2026-11-07T00:26:55Z"
      }
    }
  ],
  "reported_at": null,
  "fetched_at": "2026-11-06T19:36:54.719Z"
}
```

## Metric Fields Semantics

| Field                | Type                                 | Description                                                                                                           |
| -------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `string`                             | Unique identifier (e.g., model ID `gemini-2.5-flash-thinking`).                                                       |
| `name`               | `string \| null`                     | Human-readable display name from upstream (e.g., `Gemini 3.5 Flash Lite`).                                            |
| `nature`             | `"quota" \| "usage" \| "rate_limit"` | Nature of the metric. Set to `"rate_limit"` for periodic reset limits.                                                |
| `used`               | `number \| null`                     | Absolute used quantity if reported by upstream (`null` when not provided).                                            |
| `limit`              | `number \| null`                     | Absolute limit if reported by upstream (`null` when not provided).                                                    |
| `remaining`          | `number \| null`                     | Absolute remaining quantity if reported by upstream (`null` when not provided).                                       |
| `percentage`         | `number \| null`                     | Upstream percentage (`null` when upstream provides only fractional ratio without calculating artificial percentages). |
| `remaining_fraction` | `number \| null`                     | Exact fraction remaining reported by Google Antigravity (`0.0` to `1.0`). Preserves explicit `0`.                     |
| `unit`               | `string \| null`                     | Unit of measure (`null` when unmetered or dimensionless).                                                             |
| `cycle`              | `string \| null`                     | Billing or reset cycle window if specified upstream.                                                                  |
| `reset_at`           | `string \| null`                     | ISO-8601 UTC timestamp when the rate limit window replenishes.                                                        |
| `reported_at`        | `string \| null`                     | Upstream report timestamp if distinct from `fetched_at`.                                                              |
| `scope`              | `string \| null`                     | Scope of the quota (`"model"`, `"account"`, etc.).                                                                    |
| `raw`                | `object \| null`                     | Complete original upstream metric metadata without loss.                                                              |

## Lifecycle States & HTTP Status Codes

| State (`status`)   | HTTP Code                 | Meaning                                                                   |
| ------------------ | ------------------------- | ------------------------------------------------------------------------- |
| `available`        | `200 OK`                  | Query succeeded and official metrics were retrieved from upstream.        |
| `unsupported`      | `200 OK`                  | Query completed, but provider/platform does not support usage inspection. |
| `unauthenticated`  | `503 Service Unavailable` | Local session missing or credentials revoked/unrefreshable.               |
| `error`            | `502 Bad Gateway`         | Upstream provider error (e.g. Google Cloud Code PA 5xx failure).          |
| `error`            | `503 Service Unavailable` | Upstream request timed out or network connectivity failed.                |
| Gateway Auth Error | `401 Unauthorized`        | Missing or invalid `x-gateway-api-key` header.                            |

## Security & Privacy Safeguards

- **No Credential Leakage**: OAuth tokens (`access_token`, `refresh_token`), private cookies, and authorization headers are never exposed in JSON responses or log outputs.
- **SSRF & Arbitrary URL Protection**: Upstream endpoints are hardcoded to official Google Cloud Code Internal PA APIs (`https://cloudcode-pa.googleapis.com` and `https://daily-cloudcode-pa.googleapis.com`). Clients cannot specify target URLs.
- **Session Isolation**: Read-only usage inspection does not modify session stores or execute agent turns/inference.

## Architecture & Reusability

Usage querying is designed around the core `ProviderUsageService` interface (`@agent-runtime-gateway/core`):

```ts
export interface ProviderUsageService {
  readonly providerId: string;
  getUsage(options?: { readonly signal?: AbortSignal }): Promise<ProviderUsageSnapshot>;
}
```

This ensures future providers (e.g. Cursor quota, OpenAI organization usage) can be integrated cleanly following the identical normalized DTO schema.
