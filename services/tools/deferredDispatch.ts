export const DISPATCH_MESSAGE_FIELD = "dispatch_message";
export const DISPATCH_MESSAGE_MAX_CHARS = 200;

export const dispatchMessageParameter = {
  type: "string",
  minLength: 1,
  maxLength: DISPATCH_MESSAGE_MAX_CHARS,
  description: "A short message in the current persona telling the user the request was received and work has started. Do not promise success or repeat the full request. Call this deferred tool by itself."
} as const;

export type DeferredDispatchMessage =
  | {
    ok: true;
    message: string;
    workerArguments: Record<string, unknown>;
  }
  | {
    ok: false;
    error: string;
  };

export function withRequiredDispatchMessage(tool: Record<string, unknown>) {
  const parameters = isRecord(tool.parameters) ? tool.parameters : {};
  const properties = isRecord(parameters.properties) ? parameters.properties : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...tool,
    parameters: {
      ...parameters,
      type: "object",
      additionalProperties: false,
      properties: {
        ...properties,
        [DISPATCH_MESSAGE_FIELD]: dispatchMessageParameter
      },
      required: [...new Set([...required, DISPATCH_MESSAGE_FIELD])]
    },
    strict: true
  };
}

export function withoutDispatchMessage(tool: Record<string, unknown>) {
  if (!isRecord(tool.parameters)) return tool;
  const parameters = tool.parameters;
  const properties = isRecord(parameters.properties) ? { ...parameters.properties } : undefined;
  if (properties) delete properties[DISPATCH_MESSAGE_FIELD];
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value) => value !== DISPATCH_MESSAGE_FIELD)
    : parameters.required;
  return {
    ...tool,
    parameters: {
      ...parameters,
      ...(properties ? { properties } : {}),
      ...(required === undefined ? {} : { required })
    }
  };
}

export function readDeferredDispatchMessage(
  argumentsValue: Record<string, unknown>,
  toolName: string
): DeferredDispatchMessage {
  const raw = argumentsValue[DISPATCH_MESSAGE_FIELD];
  if (typeof raw !== "string" || !raw.trim()) {
    return {
      ok: false,
      error: `Deferred tool ${toolName} requires a non-empty ${DISPATCH_MESSAGE_FIELD}. Call it alone and try again.`
    };
  }
  const message = raw.trim();
  if (message.length > DISPATCH_MESSAGE_MAX_CHARS) {
    return {
      ok: false,
      error: `Deferred tool ${toolName} ${DISPATCH_MESSAGE_FIELD} must not exceed ${DISPATCH_MESSAGE_MAX_CHARS} characters.`
    };
  }
  return {
    ok: true,
    message,
    workerArguments: Object.fromEntries(
      Object.entries(argumentsValue).filter(([key]) => key !== DISPATCH_MESSAGE_FIELD)
    )
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
