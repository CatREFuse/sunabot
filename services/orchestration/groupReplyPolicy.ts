export type UserGroupReplyRoute = "none" | "command" | "direct" | "ambient";
export type ReplyGateScope = "private" | "user_group" | "bot_group";

export interface UserGroupReplyPolicyInput {
  enabled: boolean;
  command: boolean;
  explicitRule: boolean;
  orchestratorEnabled: boolean;
}

export interface ReplyGateSnapshot {
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
  private readonly scopeEpochs = new Map<ReplyGateScope, number>();
  private readonly conversationEpochs = new Map<string, number>();

  capture(scope: ReplyGateScope, conversationId: string): ReplyGateSnapshot {
    return {
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
    return snapshot.scopeEpoch === (this.scopeEpochs.get(snapshot.scope) ?? 0) &&
      snapshot.conversationEpoch === (this.conversationEpochs.get(snapshot.conversationId) ?? 0);
  }
}
