import type { AgentProvider } from "../contracts/agent-provider.js";
import {
  InvalidProviderIdError,
  ProviderAlreadyRegisteredError,
  ProviderNotFoundError,
} from "../errors.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): void {
    const providerId = normalizeProviderId(provider.id);
    if (this.providers.has(providerId)) {
      throw new ProviderAlreadyRegisteredError(providerId);
    }
    this.providers.set(providerId, provider);
  }

  resolve(providerId: string): AgentProvider {
    const normalizedId = normalizeProviderId(providerId);
    const provider = this.providers.get(normalizedId);
    if (provider === undefined) {
      throw new ProviderNotFoundError(normalizedId);
    }
    return provider;
  }

  has(providerId: string): boolean {
    try {
      const normalizedId = normalizeProviderId(providerId);
      return this.providers.has(normalizedId);
    } catch (error) {
      if (error instanceof InvalidProviderIdError) {
        return false;
      }
      throw error;
    }
  }

  listIds(): string[] {
    return [...this.providers.keys()];
  }
}

function normalizeProviderId(providerId: string): string {
  const normalizedId = providerId.trim();
  if (normalizedId.length === 0) {
    throw new InvalidProviderIdError(providerId);
  }
  return normalizedId;
}
