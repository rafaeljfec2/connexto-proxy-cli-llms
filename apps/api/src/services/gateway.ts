import {
  ProviderRegistry,
  ProviderRouter,
  RuntimeExecutor,
} from "@agent-runtime-gateway/core";
import { CursorProvider } from "@agent-runtime-gateway/provider-cursor";
import {
  ResponseSessionStore,
  globalResponseStore,
} from "@agent-runtime-gateway/compatibility-openai";

export interface GatewayServices {
  executor: RuntimeExecutor;
  cursorProvider: CursorProvider;
  responseStore: ResponseSessionStore;
}

export function createGatewayServices(): GatewayServices {
  const registry = new ProviderRegistry();
  const cursorProvider = new CursorProvider();
  registry.register(cursorProvider);

  const router = new ProviderRouter(registry);
  const executor = new RuntimeExecutor(router);

  return {
    executor,
    cursorProvider,
    responseStore: globalResponseStore,
  };
}

let defaultServices: GatewayServices | undefined;

export function getGatewayServices(): GatewayServices {
  defaultServices ??= createGatewayServices();
  return defaultServices;
}
