import type { AgentExecutionInput, AgentRun } from "./execution.js";
import type { Model } from "./model.js";

export interface AgentProvider {
  readonly id: string;

  listModels(): Promise<Model[]>;

  execute(input: AgentExecutionInput): Promise<AgentRun>;
}
