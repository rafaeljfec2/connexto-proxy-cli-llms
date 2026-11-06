import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildApp } from "@agent-runtime-gateway/api";
import type { ProviderQuotaMetric } from "@agent-runtime-gateway/core";
import { resetGatewayServicesForTest } from "../apps/api/src/services/gateway.js";

const tokenFilePath = path.join(
  os.homedir(),
  ".gemini",
  "antigravity-cli",
  "antigravity-oauth-token",
);
const hasRealCredentials = fs.existsSync(tokenFilePath);

describe("Antigravity Usage Real Upstream Validation Suite", () => {
  it.skipIf(!hasRealCredentials)(
    "queries real Antigravity usage API and verifies upstream metrics without inference",
    async () => {
      resetGatewayServicesForTest();

      const app = buildApp({
        HOST: "127.0.0.1",
      });

      // 1. First query
      const res1 = await request(app).get("/v1/providers/antigravity/usage").send();

      expect(res1.status).toBe(200);
      expect(res1.body.provider).toBe("antigravity");
      expect(res1.body.status).toBe("available");
      expect(res1.body.source).toBe("agy");
      expect(res1.body.fetched_at).toBeDefined();

      // Verify account info
      expect(res1.body.account).toBeDefined();
      if (res1.body.account?.email) {
        expect(typeof res1.body.account.email).toBe("string");
        expect(res1.body.account.email).toContain("@");
      }

      // Verify quotas
      expect(Array.isArray(res1.body.quotas)).toBe(true);
      const quotas = res1.body.quotas as readonly ProviderQuotaMetric[];
      expect(quotas.length).toBeGreaterThan(0);

      for (const quota of quotas) {
        expect(typeof quota.id).toBe("string");
        expect(quota.nature).toBe("rate_limit");
        expect(quota.scope).toBe("model");
        expect(quota.used).toBeNull();
        expect(quota.limit).toBeNull();
        expect(quota.remaining).toBeNull();
        expect(quota.percentage).toBeNull();

        if (quota.remaining_fraction !== null) {
          expect(typeof quota.remaining_fraction).toBe("number");
          expect(quota.remaining_fraction).toBeGreaterThanOrEqual(0);
          expect(quota.remaining_fraction).toBeLessThanOrEqual(1);
        }

        if (typeof quota.reset_at === "string") {
          expect(Number.isNaN(Date.parse(quota.reset_at))).toBe(false);
        }
      }

      // Verify no sensitive tokens are exposed
      const jsonString = JSON.stringify(res1.body);
      expect(jsonString).not.toMatch(/ya29\.[a-zA-Z0-9_-]+/);
      expect(jsonString).not.toMatch(/1\/\/[a-zA-Z0-9_-]+/);

      // 2. Repeat query (verify repeated execution succeeds without interactive prompt or inference)
      const res2 = await request(app).get("/v1/providers/antigravity/usage").send();

      expect(res2.status).toBe(200);
      expect(res2.body.status).toBe("available");
      expect(res2.body.quotas.length).toBe(res1.body.quotas.length);
    },
  );
});
