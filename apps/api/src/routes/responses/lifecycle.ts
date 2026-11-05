import type { Request, Response } from "express";
import { openAiErrorPayload } from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../../services/gateway.js";

function getParamId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : (raw ?? "");
}

export function handleGetResponse(req: Request, res: Response): void {
  const services = getGatewayServices();
  const id = getParamId(req);
  const stored = services.responseStore.get(id);
  if (!stored || !stored.responseData) {
    res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
    return;
  }
  res.status(200).json(stored.responseData);
}

export function handleDeleteResponse(req: Request, res: Response): void {
  const services = getGatewayServices();
  const id = getParamId(req);
  if (!services.responseStore.has(id)) {
    res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
    return;
  }
  services.responseStore.delete(id);
  res.status(200).json({
    id,
    object: "response",
    deleted: true,
  });
}

export function handleGetInputItems(req: Request, res: Response): void {
  const services = getGatewayServices();
  const id = getParamId(req);
  const stored = services.responseStore.get(id);
  if (!stored) {
    res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
    return;
  }
  res.status(200).json({
    object: "list",
    data: stored.inputItems ?? [],
  });
}

export function handleCancelResponse(req: Request, res: Response): void {
  const services = getGatewayServices();
  const id = getParamId(req);
  if (!services.responseStore.has(id)) {
    res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
    return;
  }
  res
    .status(400)
    .json(
      openAiErrorPayload(
        "Only background responses can be cancelled. Local responses run synchronously.",
        "invalid_request_error",
      ),
    );
}
