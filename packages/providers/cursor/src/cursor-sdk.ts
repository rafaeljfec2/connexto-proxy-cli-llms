import {
  decodeLocalAgentServerFrame,
  isEmittableSdkToolCall,
  normalizeSdkToolCallForOpenCode,
} from "./sdk/tool-decoding.js";
import {
  encodeAgentClientRequestContextResult,
  encodeAgentClientRunRequest,
} from "./sdk/proto.js";
import {
  retryPromptAfterMissingTool,
  retryPromptAfterUnsupportedTool,
} from "./sdk/prompts.js";

export type {
  ClientToolSpec,
  CursorSdkCompletion,
  CursorSdkSession,
  ToolCallDecision,
} from "./sdk/types.js";

export { createCursorSdkCompletion, collectCursorSdkOutput } from "./sdk/stream.js";

export { resetCursorSdkSessionCacheForTest } from "./sdk/session-store.js";

export const cursorSdkTestExports = {
  decodeLocalAgentServerFrame,
  encodeAgentClientRequestContextResult,
  encodeAgentClientRunRequest,
  isEmittableSdkToolCall,
  normalizeSdkToolCallForOpenCode,
  retryPromptAfterMissingTool,
  retryPromptAfterUnsupportedTool,
};
