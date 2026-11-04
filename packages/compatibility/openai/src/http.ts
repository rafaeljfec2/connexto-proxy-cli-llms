export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;

  constructor(
    message: string,
    status = 400,
    code = "invalid_request_error",
    param?: string,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

export function openAiErrorPayload(
  message: string,
  code = "invalid_request_error",
  param?: string,
): {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string;
  };
} {
  return {
    error: {
      message,
      type: code,
      param: param ?? null,
      code,
    },
  };
}

export function bearerToken(
  authorizationHeader?: string,
  apiKeyHeader?: string,
): string | undefined {
  const authorization = authorizationHeader ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (match) return match[1].trim();
  return apiKeyHeader?.trim() ?? undefined;
}
