import type { NextFunction, Request, Response } from "express";
import type { Env } from "../config/env.js";
import { getLogger } from "../utils/logger.js";
import {
  parseResponseBodyForLog,
  sanitizeRequestHeaders,
  serializePayloadForLog,
} from "../utils/http-payload-log.js";

type PayloadLoggingConfig = Pick<
  Env,
  "LOG_HTTP_PAYLOADS" | "LOG_HTTP_PAYLOAD_MAX_BYTES"
>;

export function createHttpPayloadLoggingMiddleware(
  config: Partial<PayloadLoggingConfig> = {},
): (req: Request, res: Response, next: NextFunction) => void {
  const enabled = config.LOG_HTTP_PAYLOADS ?? true;
  const maxBytes = config.LOG_HTTP_PAYLOAD_MAX_BYTES ?? 262_144;

  return (req, res, next) => {
    if (!enabled) {
      next();
      return;
    }

    const requestId =
      typeof res.locals.requestId === "string" ? res.locals.requestId : undefined;

    getLogger().info(
      {
        requestId,
        direction: "inbound",
        method: req.method,
        path: (req.path ?? "").split("?")[0],
        headers: sanitizeRequestHeaders(
          req.headers as Record<string, unknown>,
        ),
        query: serializePayloadForLog(req.query, maxBytes),
        body: serializePayloadForLog(req.body, maxBytes),
      },
      "http payload",
    );

    const chunks: Buffer[] = [];
    let jsonBody: unknown;
    let outboundLogged = false;

    const logOutbound = (): void => {
      if (outboundLogged) return;
      outboundLogged = true;

      let payload: unknown;
      if (jsonBody !== undefined) {
        payload = serializePayloadForLog(jsonBody, maxBytes);
      } else {
        const raw = Buffer.concat(chunks).toString("utf8");
        const contentType = res.getHeader("content-type");
        payload = parseResponseBodyForLog(
          raw,
          typeof contentType === "string" ? contentType : undefined,
          maxBytes,
        );
      }

      getLogger().info(
        {
          requestId,
          direction: "outbound",
          status: res.statusCode,
          body: payload,
        },
        "http payload",
      );
    };

    const originalJson = res.json.bind(res);
    res.json = function jsonWithCapture(body: unknown) {
      jsonBody = body;
      return originalJson(body);
    };

    const originalSend = res.send.bind(res);
    res.send = function sendWithCapture(body: unknown) {
      if (jsonBody === undefined && body !== undefined) {
        if (typeof body === "string") {
          chunks.push(Buffer.from(body));
        } else if (Buffer.isBuffer(body)) {
          chunks.push(body);
        } else if (typeof body === "object") {
          jsonBody = body;
        }
      }
      return originalSend(body);
    };

    const originalWrite = res.write.bind(res);
    res.write = function writeWithCapture(
      chunk: unknown,
      ...args: unknown[]
    ): boolean {
      if (chunk !== undefined && chunk !== null) {
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
        } else if (typeof chunk === "string") {
          chunks.push(Buffer.from(chunk));
        }
      }
      const writeFn = originalWrite as (
        c: unknown,
        ...rest: unknown[]
      ) => boolean;
      return writeFn(chunk, ...args);
    };

    res.on("finish", logOutbound);
    res.on("close", logOutbound);

    next();
  };
}
