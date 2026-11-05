import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { z } from "zod";

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

const envSchema = z.object({
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_FORMAT: logFormatSchema.default("json"),
  LOG_LEVEL: logLevelSchema.default("info"),
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
  return envSchema.parse(source);
}
