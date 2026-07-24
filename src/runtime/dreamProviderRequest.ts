export function assertDreamProviderRequest(request: unknown) {
  if (!isRecord(request) || !isRecord(request.response_format)) {
    invalid("Dream prompt response_format is missing.");
  }
  if (request.response_format.type !== "text") {
    invalid("Dream prompt response_format must be text.");
  }
}

function invalid(message: string): never {
  throw Object.assign(new Error(message), {
    name: "DreamPromptSchemaError",
    code: "DREAM_PROMPT_SCHEMA_INVALID",
    retryable: false
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
