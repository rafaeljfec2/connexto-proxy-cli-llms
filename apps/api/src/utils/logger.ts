import { createRequire } from "node:module";
import process from "node:process";
import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";
import { loadEnv, type LogFormat, type LogLevel } from "../config/env.js";

const require = createRequire(import.meta.url);

export interface LoggerConfig {
  readonly format?: LogFormat;
  readonly level?: LogLevel;
  readonly destination?: DestinationStream;
}

export interface SafeErrorFields {
  readonly type: string;
  readonly code?: string;
  readonly message?: string;
}

export function toSafeError(error: unknown): SafeErrorFields {
  if (error instanceof Error) {
    const errorRecord = error as Error & { code?: string };
    return {
      type: error.name,
      ...(errorRecord.code ? { code: String(errorRecord.code) } : {}),
      message: error.message,
    };
  }
  return {
    type: "UnknownError",
    message: String(error),
  };
}

export function createLogger(config: LoggerConfig = {}): Logger {
  const level = config.level ?? "info";
  const format = config.format ?? "json";

  const options: LoggerOptions = {
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (config.destination) {
    return pino(options, config.destination);
  }

  if (format === "pretty") {
    const pretty = require("pino-pretty") as typeof import("pino-pretty").default;
    const prettyStream = pretty({
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    });
    return pino(options, prettyStream);
  }

  return pino(options, process.stdout);
}

let activeLogger: Logger | undefined;

export function getLogger(): Logger {
  if (!activeLogger) {
    const env = loadEnv();
    activeLogger = createLogger({
      format: env.LOG_FORMAT,
      level: env.LOG_LEVEL,
    });
  }
  return activeLogger;
}

export function setLogger(logger: Logger): void {
  activeLogger = logger;
}
