import type { AgentExecutionInput, AgentRun } from "../contracts/execution.js";
import type { Model } from "../contracts/model.js";
import {
  InvalidProviderIdError,
  ProviderExecutionError,
  ProviderNotFoundError,
} from "../errors.js";
import type { ProviderRouter } from "../router/provider-router.js";

export class RuntimeExecutor {
  constructor(private readonly router: ProviderRouter) {}

  async listModels(providerId: string): Promise<Model[]> {
    try {
      const provider = this.router.resolve(providerId);
      return await provider.listModels();
    } catch (error) {
      return this.rethrowProviderFailure(providerId, error);
    }
  }

  async execute(providerId: string, input: AgentExecutionInput): Promise<AgentRun> {
    try {
      const provider = this.router.resolve(providerId);
      return await provider.execute(input);
    } catch (error) {
      return this.rethrowProviderFailure(providerId, error);
    }
  }

  private rethrowProviderFailure(providerId: string, error: unknown): never {
    if (
      error instanceof ProviderNotFoundError ||
      error instanceof InvalidProviderIdError ||
      error instanceof ProviderExecutionError
    ) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "Provider operation failed";

    throw new ProviderExecutionError(providerId, message, error);
  }
}
