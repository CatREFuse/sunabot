import type { MessageScopeV1 } from "../../packages/contracts/messaging/messages.js";

export function codexControlAvailable(input: {
  isAdmin: boolean;
  scope: MessageScopeV1;
  promptOverride?: string;
  platform?: NodeJS.Platform;
  runtimeMode?: string;
}) {
  return input.isAdmin
    && input.scope === "private"
    && input.promptOverride === undefined
    && (input.platform ?? process.platform) === "darwin"
    && (input.runtimeMode ?? process.env.SUNABOT_RUNTIME_MODE) !== "docker";
}

export function codexTurnAvailable(input: {
  enabled: boolean;
  control: boolean;
  workerAvailable: boolean;
}) {
  return input.enabled && (input.control || input.workerAvailable);
}
