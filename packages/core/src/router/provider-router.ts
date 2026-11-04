import type { AgentProvider } from "../contracts/agent-provider.js";
import type { ProviderRegistry } from "../registry/provider-registry.js";

export class ProviderRouter {
  constructor(private readonly registry: ProviderRegistry) {}

  resolve(providerId: string): AgentProvider {
    return this.registry.resolve(providerId);
  }
}
