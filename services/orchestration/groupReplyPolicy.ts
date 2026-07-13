import { randomUUID } from "node:crypto";

export type UserGroupReplyRoute = "none" | "command" | "direct" | "ambient";
export type ReplyGateScope = "private" | "user_group" | "bot_group";

export interface UserGroupReplyPolicyInput {
  enabled: boolean;
  command: boolean;
  explicitRule: boolean;
  orchestratorEnabled: boolean;
}

export interface ReplyGateSnapshot {
  generation: string;
  scope: ReplyGateScope;
  conversationId: string;
  scopeEpoch: number;
  conversationEpoch: number;
}

const ORCHESTRATOR_REPLY_WINDOW_MS = 60_000;

export function resolveUserGroupReplyRoute(input: UserGroupReplyPolicyInput): UserGroupReplyRoute {
  if (!input.enabled) return "none";
  if (input.command) return "command";
  if (input.explicitRule) return "direct";
  return input.orchestratorEnabled ? "ambient" : "none";
}

export function isOrchestratorReplyRateLimited(lastReplyAt: string | undefined, now = Date.now()) {
  const lastReplyTime = Date.parse(lastReplyAt ?? "");
  return Number.isFinite(lastReplyTime) && now - lastReplyTime < ORCHESTRATOR_REPLY_WINDOW_MS;
}

export class ReplyGateEpochs {
  private readonly generation = randomUUID();
  private readonly scopeEpochs = new Map<ReplyGateScope, number>();
  private readonly conversationEpochs = new Map<string, number>();

  capture(scope: ReplyGateScope, conversationId: string): ReplyGateSnapshot {
    return {
      generation: this.generation,
      scope,
      conversationId,
      scopeEpoch: this.scopeEpochs.get(scope) ?? 0,
      conversationEpoch: this.conversationEpochs.get(conversationId) ?? 0
    };
  }

  invalidateScope(scope: ReplyGateScope) {
    this.scopeEpochs.set(scope, (this.scopeEpochs.get(scope) ?? 0) + 1);
  }

  invalidateConversation(conversationId: string) {
    this.conversationEpochs.set(conversationId, (this.conversationEpochs.get(conversationId) ?? 0) + 1);
  }

  isCurrent(snapshot: ReplyGateSnapshot) {
    if (snapshot.generation !== this.generation) return true;
    return snapshot.scopeEpoch === (this.scopeEpochs.get(snapshot.scope) ?? 0) &&
      snapshot.conversationEpoch === (this.conversationEpochs.get(snapshot.conversationId) ?? 0);
  }
}

export function readReplyGateSnapshot(
  value: unknown,
  expectedScope: ReplyGateScope,
  expectedConversationId: string
): ReplyGateSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const gate = value as Record<string, unknown>;
  if (
    typeof gate.generation !== "string" || !gate.generation.trim() ||
    gate.scope !== expectedScope ||
    gate.conversationId !== expectedConversationId ||
    !Number.isSafeInteger(gate.scopeEpoch) || Number(gate.scopeEpoch) < 0 ||
    !Number.isSafeInteger(gate.conversationEpoch) || Number(gate.conversationEpoch) < 0
  ) return undefined;
  return {
    generation: gate.generation,
    scope: expectedScope,
    conversationId: expectedConversationId,
    scopeEpoch: Number(gate.scopeEpoch),
    conversationEpoch: Number(gate.conversationEpoch)
  };
}
