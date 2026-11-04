export interface CursorMe {
  apiKeyName: string;
  userId?: number;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  createdAt: string;
}

export type CursorImage =
  | { url: string; dimension?: { width: number; height: number }; uuid?: string }
  | {
      data: string;
      mimeType: string;
      dimension?: { width: number; height: number };
      uuid?: string;
    };

export interface CursorPrompt {
  text: string;
  images?: CursorImage[];
  mode?: "ask" | "agent";
}

export interface CursorToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface CursorCompletion {
  requestId: string;
  conversationId: string;
  stream: Response;
}

export interface CompletionResult {
  id: string;
  model: string;
  created: number;
  text: string;
  promptChars: number;
  completionChars: number;
  cursorAgentId?: string;
  cursorRunId?: string;
  toolCalls?: CursorToolCall[];
}
