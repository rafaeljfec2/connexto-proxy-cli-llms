import {
  ProviderRegistry,
  ProviderRouter,
  RuntimeExecutor,
  ActiveResourceTracker,
  type AgentProvider,
} from "@agent-runtime-gateway/core";
import { CursorProvider } from "@agent-runtime-gateway/provider-cursor";
import {
  AntigravityAuthManager,
  AntigravityProvider,
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
  antigravityProvider: AgentProvider;
  antigravityAuthManager: AntigravityAuthManager;
  responseStore: ResponseSessionStore;
  activeResources: ActiveResourceTracker;
  lifecycle: RuntimeLifecycle;
}

export interface GatewayServiceOptions {
  readonly antigravityProvider?: AgentProvider;
}

export function createGatewayServices(
  env?: Pick<
    Env,
    | "RESPONSE_TTL_MS"
    | "RESPONSE_MAX_ENTRIES"
    | "SESSION_TTL_MS"
    | "LIFECYCLE_CLEANUP_INTERVAL_MS"
    | "CURSOR_DEFAULT_WORKING_DIRECTORY"
  >,
  options: GatewayServiceOptions = {},
): GatewayServices {
  const activeResources = new ActiveResourceTracker();
  const responseStore = new ResponseSessionStore({
    maxEntries: env?.RESPONSE_MAX_ENTRIES,
    ttlMs: env?.RESPONSE_TTL_MS,
  });

  const cursorProviderOptions: ConstructorParameters<typeof CursorProvider>[0] = {
    sessionOptions: {
      maxSessions: 128,
      ttlMs: env?.SESSION_TTL_MS,
    },
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

  const registry = new ProviderRegistry();
  const cursorProvider = new CursorProvider(cursorProviderOptions);
  const antigravityProvider =
    options.antigravityProvider ??
    new AntigravityProvider({
      defaultWorkingDirectory: env?.CURSOR_DEFAULT_WORKING_DIRECTORY,
      sessionOptions: { ttlMs: env?.SESSION_TTL_MS },
    });
  registry.register(cursorProvider);
  registry.register(antigravityProvider);

  const router = new ProviderRouter(registry);
  const executor = new RuntimeExecutor(router);
  const antigravityAuthManager = new AntigravityAuthManager();

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
    responseStore,
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
