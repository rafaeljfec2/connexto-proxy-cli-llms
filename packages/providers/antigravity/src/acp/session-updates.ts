import type {
  AgentSessionUpdate,
  SessionUpdateListener,
  SessionUpdateParams,
} from "./types.js";

export type SessionEventConsumer = (
  sessionId: string,
  kind: string,
  update: AgentSessionUpdate,
) => void;

function textOfChunk(update: AgentSessionUpdate): string {
  const content: unknown = update["content"];
  if (typeof content !== "object" || content === null || !("text" in content)) {
    return "";
  }
  const text = content["text"];
  return typeof text === "string" ? text : "";
}

/**
 * Accumulates streamed session updates for an in-flight prompt turn:
 * - forwards every update to the consumer (intermediate events)
 * - reconstructs the agent text from `agent_message_chunk` pieces
 * - reconstructs the reasoning text from `agent_thought_chunk` pieces
 */
export class SessionUpdateAccumulator {
  private readonly consumer: SessionEventConsumer;
  private agentText = "";
  private thoughtText = "";

  constructor(consumer: SessionEventConsumer = () => {}) {
    this.consumer = consumer;
  }

  public handle(params: SessionUpdateParams): void {
    const update = params["update"];
    if (typeof update !== "object" || update === null) {
      return;
    }
    const kind = update.sessionUpdate;

    if (kind === "agent_message_chunk") {
      this.agentText += textOfChunk(update);
      this.consumer(params["sessionId"], kind, update);
    } else if (kind === "agent_thought_chunk") {
      this.thoughtText += textOfChunk(update);
      this.consumer(params["sessionId"], kind, update);
    } else {
      this.consumer(params["sessionId"], kind, update);
    }
  }

  public getAgentText(): string {
    return this.agentText;
  }

  public getThoughtText(): string {
    return this.thoughtText;
  }
}

export function createSessionUpdateListener(
  accumulator: SessionUpdateAccumulator,
): SessionUpdateListener {
  return (params: SessionUpdateParams) => accumulator.handle(params);
}
