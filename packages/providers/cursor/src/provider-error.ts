export class CursorProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    code: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "CursorProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}
