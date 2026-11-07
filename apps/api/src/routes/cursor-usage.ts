import type { Express, Request, Response, NextFunction } from "express";
import {
  BrowserUnavailableError,
  browserUnavailableDetail,
} from "@agent-runtime-gateway/provider-cursor-usage";
import { getGatewayServices } from "../services/gateway.js";

export const CURSOR_USAGE_COLLECT_ROUTE = "/v1/providers/cursor/usage/collect";
export const CURSOR_USAGE_AUTH_BASE = "/v1/providers/cursor/auth";

type CollectBody = { accountId?: unknown; hubAccountId?: unknown };
type AuthStartBody = { accountId?: unknown; hubAccountId?: unknown };

function readAccountId(
  req: Request,
  body: CollectBody | AuthStartBody,
): string | undefined {
  const fromBody =
    typeof body.accountId === "string" ? body.accountId.trim() : undefined;
  const fromHeader = req.get("x-hub-account-id")?.trim();
  const hubFromBody =
    typeof body.hubAccountId === "string" ? body.hubAccountId.trim() : undefined;
  const hubAccountId = hubFromBody ?? fromHeader;
  const accountId = fromBody ?? hubAccountId;
  if (accountId === undefined || accountId.length === 0) {
    return undefined;
  }
  if (
    hubAccountId !== undefined &&
    fromBody !== undefined &&
    hubAccountId !== fromBody
  ) {
    return undefined;
  }
  return accountId;
}

function rejectInvalidAccount(res: Response): void {
  res.status(400).json({
    error: {
      code: "invalid_account",
      message:
        "accountId is required and must match X-Hub-Account-Id when both are sent",
    },
  });
}

export function registerCursorUsageRoutes(app: Express): void {
  const getService = () => getGatewayServices().cursorUsageService;

  app.get(
    "/v1/providers/cursor/usage/session",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const accountId =
          (typeof req.query.accountId === "string"
            ? req.query.accountId.trim()
            : undefined) ?? req.get("x-hub-account-id")?.trim();
        if (accountId === undefined || accountId.length === 0) {
          rejectInvalidAccount(res);
          return;
        }
        const result = await getService().getCollectSessionStatus(accountId);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    CURSOR_USAGE_COLLECT_ROUTE,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = (req.body ?? {}) as CollectBody;
        const accountId = readAccountId(req, body);
        if (accountId === undefined) {
          rejectInvalidAccount(res);
          return;
        }
        const result = await getService().collectUsage(accountId);
        const statusCode =
          result.status === "available"
            ? 200
            : result.status === "authentication_required" ||
                result.status === "session_expired"
              ? 401
              : result.status === "authentication_pending"
                ? 409
                : result.status === "challenge_required"
                  ? 403
                  : result.status === "browser_unavailable"
                    ? 503
                    : result.status === "timeout"
                      ? 504
                      : 502;
        res.status(statusCode).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    CURSOR_USAGE_AUTH_BASE,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = (req.body ?? {}) as AuthStartBody;
        const accountId = readAccountId(req, body);
        if (accountId === undefined) {
          rejectInvalidAccount(res);
          return;
        }
        const result = await getService().startAuth(accountId);
        res.status(200).json(result);
      } catch (error) {
        if (error instanceof BrowserUnavailableError) {
          res.status(503).json({
            status: "browser_unavailable",
            message: browserUnavailableDetail(error.cause ?? error.message),
          });
          return;
        }
        next(error);
      }
    },
  );

  app.get(
    `${CURSOR_USAGE_AUTH_BASE}/:sessionId`,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const sessionId =
          typeof req.params.sessionId === "string" ? req.params.sessionId : "";
        if (sessionId.length === 0) {
          res.status(400).json({
            error: { code: "invalid_session", message: "sessionId required" },
          });
          return;
        }
        const result = await getService().getAuthStatus(sessionId);
        res.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.delete(
    `${CURSOR_USAGE_AUTH_BASE}/:sessionId`,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const sessionId =
          typeof req.params.sessionId === "string" ? req.params.sessionId : "";
        if (sessionId.length === 0) {
          res.status(400).json({
            error: { code: "invalid_session", message: "sessionId required" },
          });
          return;
        }
        await getService().cancelAuth(sessionId);
        res.status(204).send();
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    `${CURSOR_USAGE_AUTH_BASE}/:sessionId/interaction`,
    (req: Request, res: Response, next: NextFunction): void => {
      try {
        const sessionId =
          typeof req.params.sessionId === "string" ? req.params.sessionId : "";
        const live = getService().getInteractionPage(sessionId);
        if (live === undefined) {
          res.status(404).type("html").send(interactionNotFoundHtml());
          return;
        }
        res
          .status(200)
          .type("html")
          .send(interactionPlaceholderHtml(sessionId, live.url));
      } catch (error) {
        next(error);
      }
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function interactionPlaceholderHtml(sessionId: string, loginPageUrl: string): string {
  const safeUrl = escapeHtml(loginPageUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Cursor authentication</title></head>
<body>
  <h1>Cursor login (session ${escapeHtml(sessionId)})</h1>
  <p><strong>Headed proxy:</strong> sign in in the Chromium window the proxy opened (not this tab).</p>
  <p><strong>Docker / headless:</strong> no desktop window is shown — run <code>pnpm dev</code> on the host with
  <code>CURSOR_USAGE_AUTH_HEADLESS=false</code> (stop Compose on port 9090) for Google/GitHub login.</p>
  <p>Current step in the assisted browser: <a href="${safeUrl}" rel="noopener noreferrer">${safeUrl}</a></p>
  <p>The AI Hub polls auth status automatically. When login completes, this session becomes <code>authenticated</code>.</p>
</body>
</html>`;
}

function interactionNotFoundHtml(): string {
  return `<!DOCTYPE html><html lang="en"><body><p>Auth session not found or expired.</p></body></html>`;
}
