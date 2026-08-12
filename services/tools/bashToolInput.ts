import { WORKSPACE_BASH_EXECUTION_TIMEOUT_MS } from "./bashRuntime.js";

const MAX_COMMAND_LENGTH = 4_000;

export function normalizeBashCommand(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeBashUserRequest(value: unknown, command: string) {
  if (typeof value !== "string") return command;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 32_000) : command;
}

export function normalizeBashTimeout(_value: unknown) {
  return WORKSPACE_BASH_EXECUTION_TIMEOUT_MS;
}

export function validateBasicBashCommand(command: string) {
  if (!command) return "Empty bash command.";
  if (command.length > MAX_COMMAND_LENGTH) {
    return `Command is too long. Maximum length is ${MAX_COMMAND_LENGTH} characters.`;
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(command)) {
    return "Control characters are not allowed.";
  }
  return "";
}

export function isBashConfigurationCurrent(isCurrent?: () => boolean) {
  if (!isCurrent) return true;
  try {
    return isCurrent() === true;
  } catch {
    return false;
  }
}
