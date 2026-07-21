const UNSUPPORTED_DREAM_SCHEMA_KEYWORDS = new Set(["uniqueItems"]);

export function assertDreamProviderRequest(request: unknown) {
  if (!isRecord(request) || !isRecord(request.response_format)) {
    invalid("Dream prompt response_format is missing.");
  }
  const unsupported = findUnsupportedKeyword(request.response_format);
  if (unsupported) invalid(`Dream prompt response_format contains unsupported keyword ${unsupported}.`);
}

function findUnsupportedKeyword(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const unsupported = findUnsupportedKeyword(item);
      if (unsupported) return unsupported;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const unsupported = Object.keys(value).find((key) => UNSUPPORTED_DREAM_SCHEMA_KEYWORDS.has(key));
  if (unsupported) return unsupported;
  for (const item of Object.values(value)) {
    const nested = findUnsupportedKeyword(item);
    if (nested) return nested;
  }
  return undefined;
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
