export function hasCanonicalJsonSchemaContract(actual: unknown, canonical: unknown) {
  const actualSchema = strictJsonSchema(actual);
  const canonicalSchema = strictJsonSchema(canonical);
  return actualSchema !== undefined
    && canonicalSchema !== undefined
    && equalSchemaStructure(actualSchema, canonicalSchema);
}

export function strictJsonSchema(value: unknown) {
  if (!isRecord(value) || value.type !== "json_schema" || !isRecord(value.json_schema)) {
    return undefined;
  }
  const descriptor = value.json_schema;
  return descriptor.strict === true && isRecord(descriptor.schema)
    ? descriptor.schema
    : undefined;
}

function equalSchemaStructure(actual: unknown, canonical: unknown): boolean {
  if (Array.isArray(canonical)) {
    return Array.isArray(actual)
      && actual.length === canonical.length
      && canonical.every((item, index) => equalSchemaStructure(actual[index], item));
  }
  if (isRecord(canonical)) {
    if (!isRecord(actual)) return false;
    const canonicalKeys = Object.keys(canonical).filter((key) => key !== "description");
    const actualKeys = Object.keys(actual).filter((key) => key !== "description");
    return actualKeys.length === canonicalKeys.length
      && canonicalKeys.every((key) => (
        Object.hasOwn(actual, key)
        && equalSchemaStructure(actual[key], canonical[key])
      ));
  }
  return actual === canonical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
