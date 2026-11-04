import {
  AuthenticationError,
  CursorAgentError,
  CursorSdkError,
  RateLimitError,
} from "@cursor/sdk";

export interface NormalizedCursorError {
  message: string;
  code: string;
  retryable: boolean;
  cause?: unknown;
}

export function normalizeCursorError(error: unknown): NormalizedCursorError {
  if (error instanceof AuthenticationError) {
    return {
      message: error.message,
      code: "cursor_authentication_error",
      retryable: false,
      cause: error,
    };
  }

  if (error instanceof RateLimitError) {
    return {
      message: error.message,
      code: "cursor_rate_limit",
      retryable: true,
      cause: error,
    };
  }

  if (error instanceof CursorAgentError) {
    return {
      message: error.message,
      code: "cursor_agent_error",
      retryable: false,
      cause: error,
    };
  }

  if (error instanceof CursorSdkError) {
    return {
      message: error.message,
      code: "cursor_sdk_error",
      retryable: false,
      cause: error,
    };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      code: "cursor_unknown_error",
      retryable: false,
      cause: error,
    };
  }

  return {
    message: "Cursor provider failed with an unknown error",
    code: "cursor_unknown_error",
    retryable: false,
    cause: error,
  };
}
