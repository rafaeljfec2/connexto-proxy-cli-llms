import type { Express } from "express";
import { handleCreateResponse } from "./responses/create.js";
import {
  handleCancelResponse,
  handleDeleteResponse,
  handleGetInputItems,
  handleGetResponse,
} from "./responses/lifecycle.js";
import { handleCompact, handleInputTokens } from "./responses/tokens-compact.js";

export function registerResponseRoutes(app: Express): void {
  // 1. Create response
  app.post("/v1/responses", handleCreateResponse);

  // 2. Token estimation & Compaction
  app.post("/v1/responses/input_tokens", handleInputTokens);
  app.post("/v1/responses/compact", handleCompact);

  // 3. Response lifecycle
  app.get("/v1/responses/:id", handleGetResponse);
  app.delete("/v1/responses/:id", handleDeleteResponse);
  app.get("/v1/responses/:id/input_items", handleGetInputItems);
  app.post("/v1/responses/:id/cancel", handleCancelResponse);
}
