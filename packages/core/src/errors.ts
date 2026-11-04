export class ProviderNotFoundError extends Error {
  readonly code = "PROVIDER_NOT_FOUND" as const;

  constructor(readonly providerId: string) {
    super(`Provider not found: ${providerId}`);
    this.name = "ProviderNotFoundError";
  }
}

export class ProviderAlreadyRegisteredError extends Error {
  readonly code = "PROVIDER_ALREADY_REGISTERED" as const;

  constructor(readonly providerId: string) {
    super(`Provider already registered: ${providerId}`);
    this.name = "ProviderAlreadyRegisteredError";
  }
}

export class InvalidProviderIdError extends Error {
  readonly code = "INVALID_PROVIDER_ID" as const;

  constructor(readonly providerId: string) {
    super(`Invalid provider id: ${JSON.stringify(providerId)}`);
    this.name = "InvalidProviderIdError";
  }
}

export class ProviderExecutionError extends Error {
  readonly code = "PROVIDER_EXECUTION_ERROR" as const;

  constructor(
    readonly providerId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ProviderExecutionError";
  }
}
