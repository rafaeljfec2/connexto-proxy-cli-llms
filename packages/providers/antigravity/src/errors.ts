import { HttpError } from "@agent-runtime-gateway/compatibility-openai";

export class AntigravityAuthError extends HttpError {
  constructor(
    message: string,
    status = 400,
    code = "invalid_request_error",
    param?: string,
  ) {
    super(message, status, code, param);
    this.name = "AntigravityAuthError";
  }
}

export class OperationNotFoundError extends AntigravityAuthError {
  constructor(operationId: string) {
    super(`Auth operation '${operationId}' was not found.`, 404, "operation_not_found");
    this.name = "OperationNotFoundError";
  }
}

export class OperationExpiredError extends AntigravityAuthError {
  constructor(operationId: string) {
    super(`Auth operation '${operationId}' has expired.`, 410, "operation_expired");
    this.name = "OperationExpiredError";
  }
}

export class InvalidStateError extends AntigravityAuthError {
  constructor(message = "Invalid or mismatched auth state parameter.") {
    super(message, 400, "invalid_state");
    this.name = "InvalidStateError";
  }
}

export class AuthorizationDeniedError extends AntigravityAuthError {
  constructor(details = "User or identity provider denied authorization.") {
    super(`Authorization denied: ${details}`, 400, "authorization_denied");
    this.name = "AuthorizationDeniedError";
  }
}
