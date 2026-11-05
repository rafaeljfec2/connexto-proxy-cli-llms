import type { Express, Request, Response } from "express";
import { getRuntimeSnapshot } from "../services/gateway.js";

export function registerHealthRoutes(app: Express): void {
  app.get("/health", (_req: Request, res: Response): void => {
    const snapshot = getRuntimeSnapshot();
    res.status(200).json({
      status: "ok",
      service: "agent-runtime-gateway",
      runtime: {
        responses: {
          stored: snapshot.responses.storedResponses,
          maxEntries: snapshot.responses.maxEntries,
          ttlMs: snapshot.responses.ttlMs,
          activePinned: snapshot.responses.activePinned,
          removedByTtl: snapshot.responses.removedByTtl,
          removedByLimit: snapshot.responses.removedByLimit,
        },
        sessions: {
          stored: snapshot.sessions.storedSessions,
          maxSessions: snapshot.sessions.maxSessions,
          ttlMs: snapshot.sessions.ttlMs,
          removedByTtl: snapshot.sessions.removedByTtl,
        },
        executions: snapshot.executions,
        memory: {
          rss: snapshot.memory.rss,
          heapUsed: snapshot.memory.heapUsed,
          heapTotal: snapshot.memory.heapTotal,
          external: snapshot.memory.external,
          arrayBuffers: snapshot.memory.arrayBuffers,
        },
      },
    });
  });
}
