import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import { parseCorsOrigins } from "./cors.js";
import { isLoopbackHost } from "../utils/network.js";
import { secureTokenEquals } from "../utils/secure-token.js";

export const logFormatSchema = z.enum(["json", "pretty"]);
export type LogFormat = z.infer<typeof logFormatSchema>;

export const logLevelSchema = z.enum([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);
export type LogLevel = z.infer<typeof logLevelSchema>;

const envSchema = z
  .object({
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().positive().default(3000),
    GATEWAY_API_TOKEN: z
      .string()
      .trim()
      .optional()
      .transform((token) => token || undefined),
    GATEWAY_API_TOKENS: z
      .string()
      .optional()
      .transform((raw) => {
        const tokens = [
          ...new Set(
            raw
              ?.split(",")
              .map((token) => token.trim())
              .filter((token) => token.length > 0),
          ),
        ];
        return tokens.length > 0 ? tokens : undefined;
      }),
    CORS_ORIGINS: z.string().optional().transform(parseCorsOrigins),
    LOG_FORMAT: logFormatSchema.default("json"),
    LOG_LEVEL: logLevelSchema.default("info"),
    LOG_HTTP_PAYLOADS: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .optional()
      .transform((value) => {
        if (value === undefined) return true;
        if (typeof value === "boolean") return value;
        return value !== "false" && value !== "0";
      }),
    LOG_HTTP_PAYLOAD_MAX_BYTES: z.coerce.number().int().positive().default(262_144),
    /** Max JSON request body size for express.json(); aligns with AI Hub gateway default (32 MiB). */
    GATEWAY_JSON_BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(32 * 1024 * 1024),
    RESPONSE_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
    RESPONSE_MAX_ENTRIES: z.coerce.number().int().positive().default(512),
    SESSION_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
    SESSION_STORAGE_DRIVER: z.enum(["filesystem", "memory"]).default("filesystem"),
    SESSION_STORAGE_PATH: z
      .string()
      .trim()
      .default("/var/lib/connexto-proxy/sessions"),
    LIFECYCLE_CLEANUP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    CURSOR_DEFAULT_WORKING_DIRECTORY: z
      .string()
      .optional()
      .transform((value) => {
        const trimmed = value?.trim();
        return trimmed ? trimmed : undefined;
      }),
  })
  .superRefine((env, context) => {
    const hasPrimaryToken = env.GATEWAY_API_TOKEN !== undefined;
    const hasSecondaryTokens = (env.GATEWAY_API_TOKENS?.length ?? 0) > 0;
    if (!isLoopbackHost(env.HOST) && !hasPrimaryToken && !hasSecondaryTokens) {
      context.addIssue({
        code: "custom",
        path: ["GATEWAY_API_TOKEN"],
        message: "GATEWAY_API_TOKEN is required when HOST is not loopback",
      });
    }
  });

export type Env = Readonly<z.infer<typeof envSchema>>;

export function findEnvFile(startDir = process.cwd()): string | undefined {
  let currentDir = startDir;
  while (true) {
    const candidate = path.join(currentDir, ".env");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }
  return undefined;
}

export function loadEnvFileIfPresent(filePath?: string): void {
  if (typeof process.loadEnvFile !== "function") return;

  const targetPath = filePath !== undefined ? filePath : findEnvFile();
  if (targetPath !== undefined && fs.existsSync(targetPath)) {
    process.loadEnvFile(targetPath);
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const env = envSchema.parse(source);
  const cursorApiKey = source.CURSOR_API_KEY?.trim();

  if (
    env.GATEWAY_API_TOKEN !== undefined &&
    cursorApiKey &&
    secureTokenEquals(env.GATEWAY_API_TOKEN, cursorApiKey)
  ) {
    throw new Error("GATEWAY_API_TOKEN must be different from CURSOR_API_KEY");
  }

  const secondaryTokens = env.GATEWAY_API_TOKENS ?? [];
  if (
    cursorApiKey &&
    secondaryTokens.some((token) => secureTokenEquals(token, cursorApiKey))
  ) {
    throw new Error("GATEWAY_API_TOKENS must be different from CURSOR_API_KEY");
  }

  if (
    env.GATEWAY_API_TOKEN !== undefined &&
    secondaryTokens.includes(env.GATEWAY_API_TOKEN)
  ) {
    throw new Error("GATEWAY_API_TOKENS must be different from GATEWAY_API_TOKEN");
  }

  return env;
}
