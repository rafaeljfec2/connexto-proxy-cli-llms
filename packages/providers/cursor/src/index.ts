export { CursorClient } from "./client.js";
export type { CreateLocalAgentParams, ResumeLocalAgentParams } from "./client.js";
export { resolveCursorApiKey, resolveOptionalCursorApiKey } from "./credential.js";
export { normalizeCursorError } from "./errors.js";
export type { NormalizedCursorError } from "./errors.js";
export {
  createRunCancelledEvent,
  createRunCompletedEvent,
  createRunFailedEvent,
  createRunStartedEvent,
  mapRunResultToAgentResult,
  mapSdkMessageToEvents,
} from "./events.js";
export { CursorProviderError } from "./provider-error.js";
export { CursorProvider } from "./provider.js";
export type { CursorProviderOptions } from "./provider.js";
export { CursorSessionManager } from "./sessions.js";

// Ported Composer API Core Cursor Engine
export * from "./crypto.js";
export * from "./cursor.js";
export * from "./cursor-sdk.js";
