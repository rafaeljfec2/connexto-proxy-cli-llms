import type { ErrorRequestHandler, Request, Response } from "express";
import {
  HttpError,
  openAiErrorPayload,
} from "@agent-runtime-gateway/compatibility-openai";
import { ProviderExecutionError } from "@agent-runtime-gateway/core";
import { CursorProviderError } from "@agent-runtime-gateway/provider-cursor";
import { getLogger } from "./logger.js";

interface PublicHttpError {
  readonly status: number;
  readonly message: string;
  readonly code: string;
  readonly param?: string;
  readonly type: string;
  readonly providerCode?: string;
}

const INTERNAL_ERROR: PublicHttpError = {
  status: 500,
  message: "Internal server error.",
  code: "internal_error",
  type: "Error",
};

const UPSTREAM_ERROR: PublicHttpError = {
  status: 502,
  message: "The upstream provider failed to process the request.",
  code: "upstream_error",
  type: "CursorProviderError",
};

const RATE_LIMIT_ERROR: PublicHttpError = {
  status: 429,
  message: "The upstream provider rate limit was reached.",
  code: "rate_limit_error",
  type: "CursorProviderError",
};

const PARSER_ERRORS: Readonly<Record<string, PublicHttpError>> = {
  "entity.parse.failed": {
    status: 400,
    message: "Invalid JSON request body.",
    code: "invalid_request_error",
    type: "BodyParserError",
  },
  "request.aborted": {
    status: 400,
    message: "Invalid JSON request body.",
    code: "invalid_request_error",
    type: "BodyParserError",
  },
  "request.size.invalid": {
    status: 400,
    message: "Invalid JSON request body.",
    code: "invalid_request_error",
    type: "BodyParserError",
  },
  "entity.too.large": {
    status: 413,
    message: "Request body is too large.",
    code: "invalid_request_error",
    type: "BodyParserError",
  },
  "charset.unsupported": {
    status: 415,
    message: "Unsupported request body encoding.",
    code: "invalid_request_error",
    type: "BodyParserError",
  },
  "encoding.unsupported": {
    status: 415,
    message: "Unsupported request body encoding.",
    code: "invalid_request_error",
    type: "BodyParserError",
  },
};

export function createErrorHandler(): ErrorRequestHandler {
  return (error: unknown, req: Request, res: Response, next): void => {
    void next;
    sendHttpError(error, req, res);
  };
}

export function sendHttpError(error: unknown, req: Request, res: Response): void {
  const publicError = classifyPublicError(error);
  writePublicError(publicError, res, req.aborted);
}

export function sendUpstreamFailure(res: Response): void {
  writePublicError(UPSTREAM_ERROR, res, false);
}

function classifyPublicError(error: unknown): PublicHttpError {
  const parserError = classifyParserError(error);
  if (parserError) return parserError;

  if (error instanceof HttpError) {
    if (!isHttpStatus(error.status)) return INTERNAL_ERROR;

    return {
      status: error.status,
      message: sanitizePublicMessage(error.message),
      code: isPublicCode(error.code) ? error.code : "invalid_request_error",
      ...(isPublicParam(error.param) ? { param: error.param } : {}),
      type: "HttpError",
    };
  }

  const cursorError = findCursorProviderError(error);
  if (cursorError?.code === "cursor_rate_limit") {
    return { ...RATE_LIMIT_ERROR, providerCode: cursorError.code };
  }
  if (cursorError?.code === "cursor_authentication_error") {
    return { ...UPSTREAM_ERROR, providerCode: cursorError.code };
  }
  if (
    cursorError?.code === "cursor_agent_error" ||
    cursorError?.code === "cursor_sdk_error"
  ) {
    return { ...UPSTREAM_ERROR, providerCode: cursorError.code };
  }
  if (cursorError?.code === "cursor_unknown_error") {
    return {
      ...INTERNAL_ERROR,
      type: "CursorProviderError",
      providerCode: cursorError.code,
    };
  }

  if (error instanceof ProviderExecutionError) {
    return { ...INTERNAL_ERROR, type: "ProviderExecutionError" };
  }

  return INTERNAL_ERROR;
}

function classifyParserError(error: unknown): PublicHttpError | undefined {
  if (typeof error !== "object" || error === null || !("type" in error)) {
    return undefined;
  }

  const errorType = error.type;
  if (typeof errorType !== "string" || !Object.hasOwn(PARSER_ERRORS, errorType)) {
    return undefined;
  }

  return PARSER_ERRORS[errorType];
}

function findCursorProviderError(error: unknown): CursorProviderError | undefined {
  const visited = new Set<unknown>();
  let current = error;

  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof CursorProviderError) return current;
    if (!(current instanceof Error) || visited.has(current)) return undefined;

    visited.add(current);
    current = current.cause;
  }

  return undefined;
}

function writePublicError(
  publicError: PublicHttpError,
  res: Response,
  requestAborted: boolean,
): void {
  const requestId =
    typeof res.locals.requestId === "string" ? res.locals.requestId : undefined;
  const logFields = {
    ...(requestId ? { requestId } : {}),
    status: publicError.status,
    errorType: publicError.type,
    errorCode: publicError.code,
    ...(publicError.providerCode ? { providerCode: publicError.providerCode } : {}),
  };

  if (publicError.status >= 500) {
    getLogger().error(logFields, "request processing error");
  } else if (publicError.status === 429) {
    getLogger().warn(logFields, "request failed");
  }

  if (res.headersSent || requestAborted) {
    res.destroy();
    return;
  }

  res
    .status(publicError.status)
    .json(openAiErrorPayload(publicError.message, publicError.code, publicError.param));
}

function sanitizePublicMessage(message: string): string {
  const firstLine = message.split(/[\r\n]/u, 1)[0] ?? "Invalid request.";
  return firstLine
    .replace(/\b(Bearer)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /\b((?:api[_ -]?key|access[_ -]?token|token|authorization)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /(?:[A-Za-z]:\\|\/(?:home|Users|tmp|srv|root|private|workspace)\/)[^\s"'<>]*/gu,
      "[redacted path]",
    )
    .slice(0, 256);
}

function isHttpStatus(status: number): boolean {
  return Number.isInteger(status) && status >= 400 && status <= 599;
}

function isPublicCode(code: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(code);
}

function isPublicParam(param: string | undefined): param is string {
  return param !== undefined && /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(param);
}
