export type ProviderToolSchemaProtocol =
  | "openai-responses"
  | "codex-responses"
  | "openai-chat-completions"
  | "anthropic-messages"
  | "gemini-generate-content";

export const OPENAI_STRICT_UNSUPPORTED_SCHEMA_KEYWORDS = [
  "uniqueItems",
  "oneOf",
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else"
] as const;

export const PROVIDER_TOOL_SCHEMA_CONTRACTS = {
  "openai-responses": {
    strictUnsupportedKeywords: OPENAI_STRICT_UNSUPPORTED_SCHEMA_KEYWORDS,
    oneOfUnsupportedOutsideStrict: true,
    enforceStrictObjectShape: true
  },
  "codex-responses": {
    strictUnsupportedKeywords: OPENAI_STRICT_UNSUPPORTED_SCHEMA_KEYWORDS,
    oneOfUnsupportedOutsideStrict: true,
    enforceStrictObjectShape: true
  },
  "openai-chat-completions": {
    strictUnsupportedKeywords: OPENAI_STRICT_UNSUPPORTED_SCHEMA_KEYWORDS,
    oneOfUnsupportedOutsideStrict: true,
    enforceStrictObjectShape: true
  },
  "anthropic-messages": {
    strictUnsupportedKeywords: [],
    oneOfUnsupportedOutsideStrict: false,
    enforceStrictObjectShape: false
  },
  "gemini-generate-content": {
    strictUnsupportedKeywords: [],
    oneOfUnsupportedOutsideStrict: false,
    enforceStrictObjectShape: false
  }
} as const satisfies Record<ProviderToolSchemaProtocol, {
  strictUnsupportedKeywords: readonly string[];
  oneOfUnsupportedOutsideStrict: boolean;
  enforceStrictObjectShape: boolean;
}>;

const JSON_SCHEMA_TYPES = new Set([
  "null",
  "boolean",
  "object",
  "array",
  "number",
  "integer",
  "string"
]);
const SCHEMA_MAP_CONTAINERS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas"
] as const;
const SCHEMA_SINGLE_CONTAINERS = [
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "additionalItems",
  "unevaluatedItems",
  "not",
  "if",
  "then",
  "else",
  "contentSchema"
] as const;
const SCHEMA_ARRAY_CONTAINERS = [
  "anyOf",
  "allOf",
  "oneOf",
  "prefixItems"
] as const;
const SCHEMA_BOOLEAN_KEYWORDS = [
  "uniqueItems",
  "readOnly",
  "writeOnly",
  "deprecated",
  "nullable"
] as const;

export function assertProviderToolDefinitions(
  definitions: readonly Record<string, unknown>[],
  protocol: ProviderToolSchemaProtocol = "openai-responses"
) {
  for (const definition of definitions) assertProviderToolDefinition(definition, protocol);
}

export function assertProviderToolDefinition(
  definition: Record<string, unknown>,
  protocol: ProviderToolSchemaProtocol = "openai-responses"
) {
  const name = String(definition.name ?? "").trim() || "<unnamed>";
  const parameters = definition.parameters;
  if (!isRecord(parameters) || parameters.type !== "object") {
    invalid(name, "parameters must be an object schema");
  }
  validateSchema(parameters, definition.strict === true, true, name, protocol, []);
}

export function assertMappedProviderToolDefinitions(
  definitions: readonly Record<string, unknown>[],
  protocol: ProviderToolSchemaProtocol
) {
  for (const definition of definitions) {
    assertProviderToolDefinition(mappedDefinition(definition, protocol), protocol);
  }
}

function validateSchema(
  schema: Record<string, unknown>,
  strict: boolean,
  root: boolean,
  name: string,
  protocol: ProviderToolSchemaProtocol,
  path: readonly string[]
) {
  validateCommonSchemaStructure(schema, name, path);
  const contract = PROVIDER_TOOL_SCHEMA_CONTRACTS[protocol];
  if (contract.oneOfUnsupportedOutsideStrict && "oneOf" in schema) {
    unsupportedKeyword(name, protocol, path, "oneOf");
  }
  if (contract.enforceStrictObjectShape && strict) {
    const unsupported = contract.strictUnsupportedKeywords
      .find((keyword) => keyword in schema);
    if (unsupported) unsupportedKeyword(name, protocol, path, unsupported);
    if (root && "anyOf" in schema) {
      invalid(name, `root anyOf is not supported by ${protocol} strict schemas`);
    }
  }

  if (isObjectSchema(schema)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (contract.enforceStrictObjectShape && strict) {
      if (schema.additionalProperties !== false) {
        invalid(name, "strict object schemas require additionalProperties=false");
      }
      const required = Array.isArray(schema.required)
        ? schema.required.filter((value): value is string => typeof value === "string")
        : [];
      const missing = Object.keys(properties).find((key) => !required.includes(key));
      if (missing) invalid(name, `strict object property ${missing} must be required`);
      const unknown = required.find((key) => !Object.hasOwn(properties, key));
      if (unknown) invalid(name, `strict required property ${unknown} must be defined`);
    }
  }

  for (const containerName of SCHEMA_MAP_CONTAINERS) {
    const container = schema[containerName];
    if (!isRecord(container)) continue;
    for (const [childName, value] of Object.entries(container)) {
      if (isRecord(value)) {
        validateSchema(
          value,
          strict,
          false,
          name,
          protocol,
          [...path, containerName, childName]
        );
      }
    }
  }

  const dependencies = schema.dependencies;
  if (isRecord(dependencies)) {
    for (const [dependencyName, value] of Object.entries(dependencies)) {
      if (isRecord(value)) {
        validateSchema(
          value,
          strict,
          false,
          name,
          protocol,
          [...path, "dependencies", dependencyName]
        );
      }
    }
  }

  for (const containerName of SCHEMA_SINGLE_CONTAINERS) {
    const value = schema[containerName];
    if (isRecord(value)) {
      validateSchema(value, strict, false, name, protocol, [...path, containerName]);
    }
  }

  for (const containerName of SCHEMA_ARRAY_CONTAINERS) {
    const container = schema[containerName];
    if (!Array.isArray(container)) continue;
    for (const [index, value] of container.entries()) {
      if (isRecord(value)) {
        validateSchema(
          value,
          strict,
          false,
          name,
          protocol,
          [...path, containerName, String(index)]
        );
      }
    }
  }

  const items = schema.items;
  if (isRecord(items)) {
    validateSchema(items, strict, false, name, protocol, [...path, "items"]);
  } else if (Array.isArray(items)) {
    for (const [index, value] of items.entries()) {
      if (isRecord(value)) {
        validateSchema(
          value,
          strict,
          false,
          name,
          protocol,
          [...path, "items", String(index)]
        );
      }
    }
  }
}

function validateCommonSchemaStructure(
  schema: Record<string, unknown>,
  name: string,
  path: readonly string[]
) {
  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      !types.length
      || types.some((value) => typeof value !== "string" || !JSON_SCHEMA_TYPES.has(value))
      || new Set(types).size !== types.length
    ) {
      invalidSchemaStructure(name, path, "has an invalid type");
    }
  }

  if ("required" in schema) {
    if (
      !Array.isArray(schema.required)
      || schema.required.some((value) => typeof value !== "string")
      || new Set(schema.required).size !== schema.required.length
    ) {
      invalidSchemaStructure(name, path, "required must be an array of unique strings");
    }
  }

  if ("enum" in schema && (!Array.isArray(schema.enum) || !schema.enum.length)) {
    invalidSchemaStructure(name, [...path, "enum"], "must be a non-empty array");
  }

  for (const keyword of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minContains",
    "maxContains",
    "minProperties",
    "maxProperties"
  ] as const) {
    if (
      keyword in schema
      && (
        !Number.isSafeInteger(schema[keyword])
        || Number(schema[keyword]) < 0
      )
    ) {
      invalidSchemaStructure(name, [...path, keyword], "must be a non-negative integer");
    }
  }

  for (const keyword of [
    "title",
    "description",
    "$comment",
    "$id",
    "$schema",
    "$ref",
    "$anchor",
    "$dynamicRef",
    "$dynamicAnchor",
    "pattern",
    "format",
    "contentEncoding",
    "contentMediaType"
  ] as const) {
    if (keyword in schema && typeof schema[keyword] !== "string") {
      invalidSchemaStructure(name, [...path, keyword], "must be a string");
    }
  }
  if (typeof schema.pattern === "string") {
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      invalidSchemaStructure(name, [...path, "pattern"], "must be a valid regular expression");
    }
  }

  for (const keyword of SCHEMA_BOOLEAN_KEYWORDS) {
    if (keyword in schema && typeof schema[keyword] !== "boolean") {
      invalidSchemaStructure(name, [...path, keyword], "must be a boolean");
    }
  }

  if ("examples" in schema && !Array.isArray(schema.examples)) {
    invalidSchemaStructure(name, [...path, "examples"], "must be an array");
  }

  if ("$vocabulary" in schema) {
    const vocabulary = schema.$vocabulary;
    if (!isRecord(vocabulary)) {
      invalidSchemaStructure(name, [...path, "$vocabulary"], "must be an object");
    }
    for (const [uri, required] of Object.entries(vocabulary)) {
      if (typeof required !== "boolean") {
        invalidSchemaStructure(
          name,
          [...path, "$vocabulary", uri],
          "must be a boolean"
        );
      }
    }
  }

  for (const keyword of [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf"
  ] as const) {
    if (
      keyword in schema
      && (
        typeof schema[keyword] !== "number"
        || !Number.isFinite(schema[keyword])
        || (keyword === "multipleOf" && Number(schema[keyword]) <= 0)
      )
    ) {
      invalidSchemaStructure(
        name,
        [...path, keyword],
        keyword === "multipleOf" ? "must be a positive finite number" : "must be a finite number"
      );
    }
  }

  for (const containerName of SCHEMA_MAP_CONTAINERS) {
    if (!(containerName in schema)) continue;
    const container = schema[containerName];
    if (!isRecord(container)) {
      invalidSchemaStructure(name, [...path, containerName], "must be an object");
    }
    for (const [childName, value] of Object.entries(container)) {
      if (!isSchemaNode(value)) {
        invalidSchemaStructure(
          name,
          [...path, containerName, childName],
          "must be a schema"
        );
      }
    }
  }

  for (const containerName of SCHEMA_SINGLE_CONTAINERS) {
    if (containerName in schema && !isSchemaNode(schema[containerName])) {
      invalidSchemaStructure(name, [...path, containerName], "must be a schema");
    }
  }

  for (const containerName of SCHEMA_ARRAY_CONTAINERS) {
    if (!(containerName in schema)) continue;
    const container = schema[containerName];
    if (
      !Array.isArray(container)
      || !container.length
      || container.some((value) => !isSchemaNode(value))
    ) {
      invalidSchemaStructure(
        name,
        [...path, containerName],
        "must be a non-empty array of schemas"
      );
    }
  }

  if ("items" in schema) {
    const items = schema.items;
    if (
      !isSchemaNode(items)
      && (
        !Array.isArray(items)
        || !items.length
        || items.some((value) => !isSchemaNode(value))
      )
    ) {
      invalidSchemaStructure(name, [...path, "items"], "must be a schema or schema array");
    }
  }

  if ("dependentRequired" in schema) {
    const dependentRequired = schema.dependentRequired;
    if (!isRecord(dependentRequired)) {
      invalidSchemaStructure(name, [...path, "dependentRequired"], "must be an object");
    }
    for (const [key, value] of Object.entries(dependentRequired)) {
      if (
        !Array.isArray(value)
        || value.some((item) => typeof item !== "string")
        || new Set(value).size !== value.length
      ) {
        invalidSchemaStructure(
          name,
          [...path, "dependentRequired", key],
          "must be an array of unique strings"
        );
      }
    }
  }

  if ("dependencies" in schema) {
    const dependencies = schema.dependencies;
    if (!isRecord(dependencies)) {
      invalidSchemaStructure(name, [...path, "dependencies"], "must be an object");
    }
    for (const [key, value] of Object.entries(dependencies)) {
      if (
        !isSchemaNode(value)
        && (
          !Array.isArray(value)
          || !value.length
          || value.some((item) => typeof item !== "string")
          || new Set(value).size !== value.length
        )
      ) {
        invalidSchemaStructure(
          name,
          [...path, "dependencies", key],
          "must be a schema or an array of unique strings"
        );
      }
    }
  }
}

function mappedDefinition(
  definition: Record<string, unknown>,
  protocol: ProviderToolSchemaProtocol
) {
  if (protocol === "openai-responses" || protocol === "codex-responses") {
    return definition;
  }
  if (protocol === "openai-chat-completions") {
    const mapped = definition.function;
    if (!isRecord(mapped)) invalid("<unnamed>", "chat completion tool.function must be an object");
    return mapped;
  }
  if (protocol === "anthropic-messages") {
    return {
      name: definition.name,
      description: definition.description,
      parameters: definition.input_schema
    };
  }
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parametersJsonSchema
  };
}

function unsupportedKeyword(
  name: string,
  protocol: ProviderToolSchemaProtocol,
  path: readonly string[],
  keyword: string
): never {
  const context = path.length ? path.join(".") : "<root>";
  invalid(name, `${context} contains unsupported keyword ${keyword} for ${protocol}`);
}

function invalidSchemaStructure(
  name: string,
  path: readonly string[],
  detail: string
): never {
  const context = path.length ? path.join(".") : "<root>";
  invalid(name, `${context} ${detail}`);
}

function invalid(name: string, detail: string): never {
  throw new Error(`PROVIDER_TOOL_SCHEMA_INVALID: ${name}: ${detail}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isSchemaNode(value: unknown) {
  return typeof value === "boolean" || isRecord(value);
}

function hasSchemaType(schema: Record<string, unknown>, type: string) {
  return schema.type === type
    || (Array.isArray(schema.type) && schema.type.includes(type));
}

function isObjectSchema(schema: Record<string, unknown>) {
  if (hasSchemaType(schema, "object")) return true;
  return [
    "properties",
    "patternProperties",
    "required",
    "additionalProperties",
    "dependentRequired",
    "dependentSchemas",
    "propertyNames",
    "minProperties",
    "maxProperties",
    "unevaluatedProperties"
  ].some((keyword) => keyword in schema);
}
