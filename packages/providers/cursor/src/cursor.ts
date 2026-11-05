import { encodeCursorChatRequest } from "./engine/connect-proto.js";
import { parseComposerToolCalls } from "./engine/filters.js";
import { cursorIdentityCache, evictExpiredCacheEntries } from "./engine/auth-api.js";

export type {
  CursorEnv,
  Env,
  CursorDeps,
  Deps,
  CursorModelResponse,
  CursorAccessTokenResponse,
  ProtobufField,
  EncodedCursorImage,
  ProtoField,
  CursorTextEvent,
} from "./engine/types.js";

export { defaultCursorDeps, defaultCursorEnv } from "./engine/types.js";

export type { CursorCollectedOutput } from "./engine/stream.js";

export {
  resolveCursorModel,
  createCursorCompletion,
  streamCursorText,
  collectCursorOutput,
  collectCursorText,
} from "./engine/stream.js";

export {
  verifyCursorApiKey,
  listCursorModels,
  exchangeCursorApiKey,
} from "./engine/auth-api.js";

export const cursorTestExports = {
  encodeCursorChatRequest,
  parseComposerToolCalls,
  cursorIdentityCache,
  evictExpiredCacheEntries,
};
