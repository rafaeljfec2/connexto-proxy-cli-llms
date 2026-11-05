import type { Request } from "express";
import { openApiDocument } from "./spec.js";

export function openApiForRequest(req: Request): typeof openApiDocument {
  const host = req.get("host")?.trim();
  if (host === undefined || host.length === 0) {
    return openApiDocument;
  }
  const protocol = req.protocol.length > 0 ? req.protocol : "http";
  return {
    ...openApiDocument,
    servers: [{ url: `${protocol}://${host}`, description: "Current gateway" }],
  };
}
