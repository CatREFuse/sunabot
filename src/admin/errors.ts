import { ServiceError } from "../../packages/contracts/errors/serviceError.js";

export class AdminApiError extends ServiceError {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
    public readonly latestRevision?: string
  ) {
    super(statusCode, code, message, field, latestRevision);
    this.name = "AdminApiError";
  }
}

export function badRequest(code: string, message: string, field?: string): never {
  throw new AdminApiError(400, code, message, field);
}

export function notFound(code: string, message: string): never {
  throw new AdminApiError(404, code, message);
}

export function conflict(code: string, message: string, latestRevision?: string): never {
  throw new AdminApiError(409, code, message, undefined, latestRevision);
}
