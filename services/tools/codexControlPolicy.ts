import type { MessageScopeV1 } from "../../packages/contracts/messaging/messages.js";

export function codexControlAvailable(input: {
  isAdmin: boolean;
  scope: MessageScopeV1;
  promptOverride?: string;
  platform?: NodeJS.Platform;
}) {
  return input.isAdmin
    && input.scope === "private"
    && input.promptOverride === undefined
    && (input.platform ?? process.platform) === "darwin";
}

export function codexTurnAvailable(input: {
  enabled: boolean;
  control: boolean;
  workerAvailable: boolean;
  requiresWorker?: boolean;
}) {
  return input.enabled
    && (input.workerAvailable || (input.control && input.requiresWorker !== true));
}
