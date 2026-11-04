import type { ModelSelection } from "@cursor/sdk";
import { Agent, Cursor, type SDKAgent } from "@cursor/sdk";
import path from "node:path";

export interface CreateLocalAgentParams {
  apiKey: string;
  model: string;
  name: string;
  workingDirectory: string;
}

export interface ResumeLocalAgentParams extends CreateLocalAgentParams {
  agentId: string;
}

export class CursorClient {
  async listModels(apiKey: string): Promise<Array<{ id: string; name?: string }>> {
    const models = await Cursor.models.list({ apiKey });
    return models.map((model) => ({
      id: model.id,
      name: model.displayName ?? model.id,
    }));
  }

  async createLocalAgent(params: CreateLocalAgentParams): Promise<SDKAgent> {
    return Agent.create({
      apiKey: params.apiKey,
      model: toModelSelection(params.model),
      name: params.name,
      local: {
        cwd: path.resolve(params.workingDirectory),
      },
    });
  }

  async resumeLocalAgent(params: ResumeLocalAgentParams): Promise<SDKAgent> {
    return Agent.resume(params.agentId, {
      apiKey: params.apiKey,
      model: toModelSelection(params.model),
      local: {
        cwd: path.resolve(params.workingDirectory),
      },
    });
  }
}

function toModelSelection(model: string): ModelSelection {
  return { id: model };
}
