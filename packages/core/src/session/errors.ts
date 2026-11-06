export class SessionStorageError extends Error {
  readonly code = "SESSION_STORAGE_ERROR" as const;

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "SessionStorageError";
  }
}

export class InvalidSessionKeyError extends SessionStorageError {
  constructor(identifier: string, context: "namespace" | "key") {
    super(
      `Invalid session ${context} "${identifier}". Identifiers must match /^[a-zA-Z0-9_-]+$/ and not contain path separators or traversal characters.`,
    );
    this.name = "InvalidSessionKeyError";
  }
}

export class SessionSerializationError extends SessionStorageError {
  constructor(key: string, cause?: unknown) {
    super(`Failed to serialize or deserialize session entry for key "${key}"`, cause);
    this.name = "SessionSerializationError";
  }
}
