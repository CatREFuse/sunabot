export interface ServiceErrorShape {
  error: {
    code: string;
    message: string;
    field?: string;
    latestRevision?: string;
  };
}

export class ServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly field?: string,
    public readonly latestRevision?: string
  ) {
    super(message);
    this.name = "ServiceError";
  }

  toJSON(): ServiceErrorShape {
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
