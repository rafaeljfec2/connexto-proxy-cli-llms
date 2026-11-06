import os from "node:os";
import path from "node:path";
import {
  ProviderRegistry,
  ProviderRouter,
  RuntimeExecutor,
  ActiveResourceTracker,
  FilesystemSessionStore,
  InMemorySessionStore,
  type SessionStore,
} from "@agent-runtime-gateway/core";
import {
  CursorProvider,
  type CursorProviderOptions,
} from "@agent-runtime-gateway/provider-cursor";
import {
  AntigravityAuthManager,
  AntigravityProvider,
  AntigravityUsageService,
  type AntigravityProviderOptions,
} from "@agent-runtime-gateway/provider-antigravity";
import { ResponseSessionStore } from "@agent-runtime-gateway/compatibility-openai";
import type { Env } from "../config/env.js";
import {
  RuntimeLifecycle,
  type RuntimeLifecycleSnapshot,
} from "../runtime/lifecycle.js";

export interface GatewayServices {
  executor: RuntimeExecutor;
  cursorProvider: CursorProvider;
  antigravityProvider: AntigravityProvider;
  antigravityAuthManager: AntigravityAuthManager;
  antigravityUsageService: AntigravityUsageService;
  responseStore: ResponseSessionStore;
  sessionStore: SessionStore<unknown>;
  activeResources: ActiveResourceTracker;
  lifecycle: RuntimeLifecycle;
}

export interface GatewayServiceOptions {
  readonly antigravityProvider?: AntigravityProvider;
  readonly antigravityUsageService?: AntigravityUsageService;
  readonly antigravityAuthManager?: AntigravityAuthManager;
  /** Test seam: inject to assert runtime session clear without real Cursor SDK. */
  readonly cursorProvider?: CursorProvider;
  readonly sessionStore?: SessionStore<unknown>;
}

export function createGatewayServices(
  env?: Partial<
    Pick<
      Env,
      | "HOST"
      | "RESPONSE_TTL_MS"
      | "RESPONSE_MAX_ENTRIES"
      | "SESSION_TTL_MS"
      | "SESSION_STORAGE_DRIVER"
      | "SESSION_STORAGE_PATH"
      | "LIFECYCLE_CLEANUP_INTERVAL_MS"
      | "CURSOR_DEFAULT_WORKING_DIRECTORY"
      | "ANTIGRAVITY_STORAGE_PATH"
    >
  >,
  options: GatewayServiceOptions = {},
): GatewayServices {
  const activeResources = new ActiveResourceTracker();
  const responseStore = new ResponseSessionStore({
    maxEntries: env?.RESPONSE_MAX_ENTRIES,
    ttlMs: env?.RESPONSE_TTL_MS,
  });

  const sessionStore =
    options.sessionStore ??
    (env?.SESSION_STORAGE_DRIVER === "memory"
      ? new InMemorySessionStore<unknown>()
      : new FilesystemSessionStore<unknown>({
          rootDir: env?.SESSION_STORAGE_PATH ?? "/var/lib/connexto-proxy/sessions",
        }));

  const cursorProviderOptions: CursorProviderOptions = {
    sessionOptions: {
      maxSessions: 128,
      ttlMs: env?.SESSION_TTL_MS,
    },
    sessionStore: sessionStore as unknown as CursorProviderOptions["sessionStore"],
    executionGuard: {
      onExecutionStart: ({ sessionId }) => {
        activeResources.pinSession(sessionId);
      },
      onExecutionEnd: ({ sessionId }) => {
        activeResources.unpinSession(sessionId);
      },
    },
  };

  if (env?.CURSOR_DEFAULT_WORKING_DIRECTORY !== undefined) {
    cursorProviderOptions.defaultWorkingDirectory =
      env.CURSOR_DEFAULT_WORKING_DIRECTORY;
  }

  const antigravityStoragePath =
    env?.ANTIGRAVITY_STORAGE_PATH ??
    path.join(os.homedir(), ".connexto-proxy", "antigravity");

  const registry = new ProviderRegistry();
  const cursorProvider =
    options.cursorProvider ?? new CursorProvider(cursorProviderOptions);
  const antigravityOptions: AntigravityProviderOptions = {
    defaultWorkingDirectory: env?.CURSOR_DEFAULT_WORKING_DIRECTORY,
    sessionOptions: { ttlMs: env?.SESSION_TTL_MS },
    sessionStore: sessionStore as unknown as AntigravityProviderOptions["sessionStore"],
    homeDir: antigravityStoragePath,
  };
  const antigravityProvider =
    options.antigravityProvider ?? new AntigravityProvider(antigravityOptions);

  registry.register(cursorProvider);
  registry.register(antigravityProvider);

  const router = new ProviderRouter(registry);
  const executor = new RuntimeExecutor(router);
  const antigravityAuthManager =
    options.antigravityAuthManager ??
    new AntigravityAuthManager({ homeDir: antigravityStoragePath });
  const antigravityUsageService =
    options.antigravityUsageService ??
    new AntigravityUsageService({ homeDir: antigravityStoragePath });

  const lifecycle = new RuntimeLifecycle({
    responseStore,
    sessions: cursorProvider.getSessionManager(),
    tracker: activeResources,
    options: {
      intervalMs: env?.LIFECYCLE_CLEANUP_INTERVAL_MS ?? 60_000,
    },
  });

  return {
    executor,
    cursorProvider,
    antigravityProvider,
    antigravityAuthManager,
    antigravityUsageService,
    responseStore,
    sessionStore,
    activeResources,
    lifecycle,
  };
}

let defaultServices: GatewayServices | undefined;

export function getGatewayServices(): GatewayServices {
  defaultServices ??= createGatewayServices();
  return defaultServices;
}

export function initializeGatewayServices(
  env: Parameters<typeof createGatewayServices>[0],
  options: GatewayServiceOptions = {},
): GatewayServices {
  defaultServices = createGatewayServices(env, options);
  return defaultServices;
}

export function resetGatewayServicesForTest(): void {
  defaultServices?.lifecycle.stop();
  defaultServices = undefined;
}

export function getRuntimeSnapshot(): RuntimeLifecycleSnapshot {
  return getGatewayServices().lifecycle.snapshot();
}
