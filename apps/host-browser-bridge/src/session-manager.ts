import crypto from "node:crypto";
import fs from "node:fs";
import { ChromeLauncher } from "./chrome-launcher.js";
import {
  SessionLimitError,
  SessionNotFoundError,
  SessionOwnershipError,
  type BrowserSession,
  type ChromeProcess,
} from "./types.js";

export interface CreateSessionParams {
  readonly id?: string;
  readonly principalId: string;
  readonly target: string;
  readonly targetUrl?: string;
  readonly ttlMs?: number;
  readonly headless?: boolean;
  readonly persistentProfile?: boolean;
}

export interface SessionManagerOptions {
  readonly maxConcurrentSessions?: number;
  readonly defaultTtlMs?: number;
  readonly launcher?: ChromeLauncher;
  readonly cleanupProfileOnClose?: boolean;
}

const DEFAULT_MAX_CONCURRENT_SESSIONS = 5;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class BrowserSessionManager {
  private readonly maxConcurrentSessions: number;
  private readonly defaultTtlMs: number;
  private readonly launcher: ChromeLauncher;
  private readonly cleanupProfileOnClose: boolean;

  private readonly sessions = new Map<string, BrowserSession>();
  private readonly processes = new Map<string, ChromeProcess>();
  private readonly expirationTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: SessionManagerOptions = {}) {
    this.maxConcurrentSessions =
      options.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS;
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.launcher = options.launcher ?? new ChromeLauncher();
    this.cleanupProfileOnClose = options.cleanupProfileOnClose ?? false;
  }

  public get activeSessionsCount(): number {
    return this.sessions.size;
  }

  private purgeDisconnectedSessions(): void {
    for (const [id, session] of this.sessions.entries()) {
      const proc = this.processes.get(id);
      if (session.status === "disconnected" || (proc && !proc.isAlive())) {
        const timer = this.expirationTimers.get(id);
        if (timer) {
          clearTimeout(timer);
          this.expirationTimers.delete(id);
        }
        this.processes.delete(id);
        this.sessions.delete(id);
      }
    }
  }

  public async createSession(
    params: CreateSessionParams,
  ): Promise<BrowserSession> {
    if (!params.principalId || params.principalId.trim().length === 0) {
      throw new Error("principalId is required");
    }
    if (!params.target || params.target.trim().length === 0) {
      throw new Error("target is required");
    }

    this.purgeDisconnectedSessions();

    const sessionId = params.id ?? crypto.randomUUID();

    // Idempotency check: if session already exists for this id
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.principalId !== params.principalId) {
        throw new SessionOwnershipError();
      }

      const proc = this.processes.get(sessionId);
      if (proc && proc.isAlive()) {
        return existing;
      }

      // If existing process died, clean up old entry before recreating
      await this.closeSession(sessionId, params.principalId);
    }

    // Check if there is already an active living session for this principal
    const existingForPrincipal = [...this.sessions.values()].find(
      (s) => s.principalId === params.principalId,
    );
    if (existingForPrincipal) {
      const proc = this.processes.get(existingForPrincipal.id);
      if (proc && proc.isAlive()) {
        // If the caller specified a specific new id (different from existing), terminate old session and proceed
        if (params.id && params.id !== existingForPrincipal.id) {
          await this.closeSession(existingForPrincipal.id, params.principalId);
        } else {
          return existingForPrincipal;
        }
      } else {
        await this.closeSession(existingForPrincipal.id, params.principalId);
      }
    }

    if (this.sessions.size >= this.maxConcurrentSessions) {
      throw new SessionLimitError(this.maxConcurrentSessions);
    }

    const now = new Date().toISOString();
    const ttlMs = params.ttlMs ?? this.defaultTtlMs;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();

    const isPersistent = params.persistentProfile !== false;
    let userDataDir: string;
    if (isPersistent && typeof this.launcher.resolvePrincipalUserDataDir === "function") {
      userDataDir = this.launcher.resolvePrincipalUserDataDir(params.principalId);
    } else if (typeof this.launcher.resolveSessionUserDataDir === "function") {
      userDataDir = this.launcher.resolveSessionUserDataDir(sessionId);
    } else {
      userDataDir = `profiles/${isPersistent ? params.principalId : sessionId}`;
    }

    const chromeProcess = await this.launcher.launch(sessionId, {
      targetUrl: params.targetUrl,
      headless: params.headless,
      userDataDir,
    });

    const session: BrowserSession = {
      id: sessionId,
      principalId: params.principalId,
      target: params.target,
      status: "waiting_for_login",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      cdpPort: chromeProcess.port,
      userDataDir: chromeProcess.userDataDir,
      persistentProfile: isPersistent,
      processId: chromeProcess.processId,
      wsEndpoint: chromeProcess.wsEndpoint,
    };

    this.sessions.set(sessionId, session);
    this.processes.set(sessionId, chromeProcess);

    const timer = setTimeout(() => {
      void this.handleSessionExpiration(sessionId);
    }, ttlMs);
    this.expirationTimers.set(sessionId, timer);

    return session;
  }

  public getSession(sessionId: string, principalId: string): BrowserSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    if (session.principalId !== principalId) {
      throw new SessionOwnershipError();
    }

    // Refresh alive status
    const proc = this.processes.get(sessionId);
    if (proc && !proc.isAlive() && session.status !== "disconnected") {
      session.status = "disconnected";
      session.updatedAt = new Date().toISOString();
    }

    return session;
  }

  public listSessions(principalId?: string): BrowserSession[] {
    const all = [...this.sessions.values()];
    if (principalId) {
      return all.filter((s) => s.principalId === principalId);
    }
    return all;
  }

  public async closeSession(
    sessionId: string,
    principalId: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (session.principalId !== principalId) {
      throw new SessionOwnershipError();
    }

    // Cancel expiration timer
    const timer = this.expirationTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.expirationTimers.delete(sessionId);
    }

    // Terminate process
    const proc = this.processes.get(sessionId);
    if (proc) {
      await proc.close();
      this.processes.delete(sessionId);
    }

    // Profile directory cleanup ONLY if configured and session is not persistent
    if (
      this.cleanupProfileOnClose &&
      !session.persistentProfile &&
      fs.existsSync(session.userDataDir)
    ) {
      try {
        fs.rmSync(session.userDataDir, { recursive: true, force: true });
      } catch {
        // Best effort file cleanup on Windows
      }
    }

    session.status = "disconnected";
    session.updatedAt = new Date().toISOString();
    this.sessions.delete(sessionId);
  }

  public async closeAll(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (session) {
        await this.closeSession(sessionId, session.principalId);
      }
    }
  }

  private async handleSessionExpiration(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = "expired";
      session.updatedAt = new Date().toISOString();
      await this.closeSession(sessionId, session.principalId);
    }
  }
}

