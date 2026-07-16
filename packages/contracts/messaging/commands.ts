export const MAX_COMMAND_INVOCATION_ID_CHARACTERS = 64;
export const MAX_COMMAND_INVOCATION_NAME_CHARACTERS = 128;
export const MAX_COMMAND_INVOCATION_ARGS_CHARACTERS = 4_096;
export const MAX_COMMAND_INVOCATION_RAW_TEXT_CHARACTERS = 8_192;

export interface CommandInvocationV1 {
  id: string;
  invokedName: string;
  args: string;
  rawText: string;
}

export function readCommandInvocationV1(value: unknown): CommandInvocationV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => (
    key !== "id" && key !== "invokedName" && key !== "args" && key !== "rawText"
  ))) return undefined;
  if (!boundedIdentifier(input.id, MAX_COMMAND_INVOCATION_ID_CHARACTERS)) return undefined;
  if (!boundedCommandName(input.invokedName)) return undefined;
  if (!boundedCommandText(input.args, MAX_COMMAND_INVOCATION_ARGS_CHARACTERS, true)) return undefined;
  if (!boundedCommandText(input.rawText, MAX_COMMAND_INVOCATION_RAW_TEXT_CHARACTERS, false)) return undefined;
  return {
    id: input.id,
    invokedName: input.invokedName,
    args: input.args,
    rawText: input.rawText
  };
}

export function validCommandInvocationIdV1(value: unknown): value is string {
  return boundedIdentifier(value, MAX_COMMAND_INVOCATION_ID_CHARACTERS);
}

function boundedIdentifier(value: unknown, maxCharacters: number): value is string {
  return typeof value === "string" && value.length > 0
    && value === value.trim() && Array.from(value).length <= maxCharacters
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function boundedCommandName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value === value.trim() && Array.from(value).length <= MAX_COMMAND_INVOCATION_NAME_CHARACTERS
    && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function boundedCommandText(
  value: unknown,
  maxCharacters: number,
  allowEmpty: boolean
): value is string {
  return typeof value === "string" && (allowEmpty || value.length > 0)
    && Array.from(value).length <= maxCharacters && !value.includes("\0");
}
