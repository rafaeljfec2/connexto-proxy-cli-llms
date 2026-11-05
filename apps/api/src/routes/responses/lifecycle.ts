import type { Request, Response } from "express";
import { openAiErrorPayload } from "@agent-runtime-gateway/compatibility-openai";
import { getGatewayServices } from "../../services/gateway.js";
import { findOwnedResponse, resolveRequestPrincipal } from "../../utils/identity.js";

function getParamId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : (raw ?? "");
}

/**
 * Every lifecycle operation requires an authenticated principal and an
 * owned resource. Unknown, foreign, and owner-less resources are rejected
 * with the same indistinguishable not-found payload.
 */
function requireOwned(
  req: Request,
  res: Response,
): { id: string; principal: string } | undefined {
  const principal = resolveRequestPrincipal(res.locals);
  if (principal === undefined) {
    res
      .status(401)
      .json(openAiErrorPayload("Missing or invalid gateway API key", "unauthorized"));
    return undefined;
  }
  return { id: getParamId(req), principal };
}

function rejectNotFound(res: Response): void {
  res.status(404).json(openAiErrorPayload("Response not found", "not_found"));
}

export function handleGetResponse(req: Request, res: Response): void {
  const services = getGatewayServices();
  const context = requireOwned(req, res);
  if (context === undefined) return;

  const stored = findOwnedResponse(
    services.responseStore,
    context.id,
    context.principal,
  );
  if (!stored || !stored.responseData) {
    rejectNotFound(res);
    return;
  }
  res.status(200).json(stored.responseData);
}

export function handleDeleteResponse(req: Request, res: Response): void {
  const services = getGatewayServices();
  const context = requireOwned(req, res);
  if (context === undefined) return;

  const stored = findOwnedResponse(
    services.responseStore,
    context.id,
    context.principal,
  );
  if (!stored) {
    rejectNotFound(res);
    return;
  }
  services.responseStore.delete(context.id);
  res.status(200).json({
    id: context.id,
    object: "response",
    deleted: true,
  });
}

export function handleGetInputItems(req: Request, res: Response): void {
  const services = getGatewayServices();
  const context = requireOwned(req, res);
  if (context === undefined) return;

  const stored = findOwnedResponse(
    services.responseStore,
    context.id,
    context.principal,
  );
  if (!stored) {
    rejectNotFound(res);
    return;
  }
  res.status(200).json({
    object: "list",
    data: stored.inputItems ?? [],
  });
}

export function handleCancelResponse(req: Request, res: Response): void {
  const services = getGatewayServices();
  const context = requireOwned(req, res);
  if (context === undefined) return;

  const stored = findOwnedResponse(
    services.responseStore,
    context.id,
    context.principal,
  );
  if (!stored) {
    rejectNotFound(res);
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
