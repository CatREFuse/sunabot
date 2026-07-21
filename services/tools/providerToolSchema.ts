const STRICT_UNSUPPORTED_KEYWORDS = [
  "oneOf",
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else"
] as const;

export function assertProviderToolDefinitions(definitions: readonly Record<string, unknown>[]) {
  for (const definition of definitions) assertProviderToolDefinition(definition);
}

export function assertProviderToolDefinition(definition: Record<string, unknown>) {
  const name = String(definition.name ?? "").trim() || "<unnamed>";
  const parameters = definition.parameters;
  if (!isRecord(parameters) || parameters.type !== "object") {
    invalid(name, "parameters must be an object schema");
  }
  validateSchema(parameters, definition.strict === true, true, name);
}

function validateSchema(
  schema: Record<string, unknown>,
  strict: boolean,
  root: boolean,
  name: string
) {
  if ("oneOf" in schema) invalid(name, "oneOf is not permitted in Provider-facing schemas");
  if (strict) {
    const unsupported = STRICT_UNSUPPORTED_KEYWORDS.find((keyword) => keyword in schema);
    if (unsupported) invalid(name, `${unsupported} is not supported in strict mode`);
    if (root && "anyOf" in schema) invalid(name, "root anyOf is not supported in strict mode");
  }

  if (schema.type === "object") {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (strict) {
      if (schema.additionalProperties !== false) {
        invalid(name, "strict object schemas require additionalProperties=false");
      }
      const required = Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === "string")
        : [];
      const missing = Object.keys(properties).find((key) => !required.includes(key));
      if (missing) invalid(name, `strict object property ${missing} must be required`);
    }
    for (const value of Object.values(properties)) {
      if (isRecord(value)) validateSchema(value, strict, false, name);
    }
  }

  if (Array.isArray(schema.anyOf)) {
    for (const value of schema.anyOf) {
      if (isRecord(value)) validateSchema(value, strict, false, name);
    }
  }
  if (isRecord(schema.items)) validateSchema(schema.items, strict, false, name);
  for (const container of [schema.$defs, schema.definitions]) {
    if (!isRecord(container)) continue;
    for (const value of Object.values(container)) {
      if (isRecord(value)) validateSchema(value, strict, false, name);
    }
  }
}

function invalid(name: string, detail: string): never {
  throw new Error(`PROVIDER_TOOL_SCHEMA_INVALID: ${name}: ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
