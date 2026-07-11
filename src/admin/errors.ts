export interface ApiErrorShape {
  error: {
    code: string;
    message: string;
    field?: string;
    latestRevision?: string;
  };
}

export class AdminApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
    public readonly latestRevision?: string
  ) {
    super(message);
    this.name = "AdminApiError";
  }

  toJSON(): ApiErrorShape {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field ? { field: this.field } : {}),
        ...(this.latestRevision ? { latestRevision: this.latestRevision } : {})
      }
    };
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
