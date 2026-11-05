import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
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
    LOG_FORMAT: logFormatSchema.default("json"),
    LOG_LEVEL: logLevelSchema.default("info"),
  })
  .superRefine((env, context) => {
    if (!isLoopbackHost(env.HOST) && env.GATEWAY_API_TOKEN === undefined) {
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

  return env;
}
