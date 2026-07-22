import {
  assistantReplyEnvelope,
  type ReplyGateSnapshotV1
} from "../../../packages/contracts/session/runtimeMessages.js";
import type {
  SessionHandleResult
} from "../../../services/sessions/sessionCoordinator.js";
import {
  type ClaimedTurn,
  type ClaimOptions,
  type EnqueueSessionEventInput,
  type EnqueueSessionEventResult,
  type OutboxDraft,
  SessionStore
} from "../../../services/sessions/sessionStore.js";

type EventQueue = Pick<SessionStore, "enqueueEvent">;
type DeferredHandleResult = Extract<SessionHandleResult, { status: "deferred" }>;
type ReleasePolicy = "unchanged" | "private_scope_plus_one";

export function enqueueIncoming(
  target: EventQueue,
  sessionId: string,
  payload: unknown = {},
  options: Omit<EnqueueSessionEventInput, "sessionId" | "kind" | "payload"> = {}
): EnqueueSessionEventResult {
  return target.enqueueEvent({ sessionId, kind: "incoming", payload, ...options });
}

export function enqueueDebounce(
  target: EventQueue,
  sessionId: string,
  payload: unknown = {},
  options: Omit<EnqueueSessionEventInput, "sessionId" | "kind" | "payload"> = {}
): EnqueueSessionEventResult {
  return target.enqueueEvent({ sessionId, kind: "reply_debounce", payload, ...options });
}

export function claimIncoming(
  store: SessionStore,
  sessionId: string,
  workerId: string,
  payload: unknown = {},
  options: Omit<ClaimOptions, "workerId" | "sessionId"> = {}
): ClaimedTurn {
  enqueueIncoming(store, sessionId, payload);
  const claim = store.claimNextTurn({ workerId, sessionId, ...options });
  if (!claim) throw new Error(`Expected a claimable incoming event for ${sessionId}.`);
  return claim;
}

export function deferredToolResult(
  event: { payload: unknown },
  providerCallId: string,
  arguments_: unknown,
  acknowledgement: string | OutboxDraft,
  toolName = "codex"
): DeferredHandleResult {
  return {
    status: "deferred",
    providerCallId,
    toolName,
    arguments: arguments_,
    originalRequest: event.payload,
    acknowledgement: typeof acknowledgement === "string"
      ? { kind: "reply", payload: { text: acknowledgement } }
      : acknowledgement
  };
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition was not met before timeout.");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

interface HeldReplyFixtureInput {
  fingerprint: string;
  generation: string;
  conversationId: string;
  userId: number;
  messageId: number;
  scopeEpoch: number;
  conversationEpoch: number;
  correlationId: string;
  senderDisplayName?: string;
  generatedImageUrl?: string;
}

export function createHeldReplyFixture(input: HeldReplyFixtureInput) {
  const gate: ReplyGateSnapshotV1 = {
    generation: input.generation,
    scope: "private",
    conversationId: input.conversationId,
    scopeEpoch: input.scopeEpoch,
    conversationEpoch: input.conversationEpoch
  };
  return {
    fingerprint: input.fingerprint,
    gate,
    options: (releasePolicy: ReleasePolicy) => ({
      mutationFingerprint: input.fingerprint,
      semantics: "system_config_confirmation" as const,
      originalReplyGate: gate,
      releasePolicy
    }),
    draft: (releasePolicy: ReleasePolicy) => ({
      kind: "onebot.reply" as const,
      deliveryPartition: "primary",
      dedupeFingerprint: "reply-fingerprint",
      payload: assistantReplyEnvelope({
        type: "assistant_reply",
        incoming: {
          schemaVersion: 1,
          transport: "onebot",
          agentId: "plana",
          accountId: "primary",
          scope: "private",
          messageId: input.messageId,
          time: "2026-07-17T00:00:00.000Z",
          userId: input.userId,
          selfId: 20002,
          sender: {
            id: String(input.userId),
            ...(input.senderDisplayName ? { displayName: input.senderDisplayName } : {})
          },
          text: "关闭私聊回复",
          media: [],
          attachments: [],
          replyMessageIds: [],
          quoteReferences: [],
          mentionedSelf: false
        },
        text: "设置已经保存。",
        generatedImages: input.generatedImageUrl ? [{ url: input.generatedImageUrl }] : [],
        isAdmin: true,
        messageOrigin: "text",
        toolNames: ["system_config"],
        ...(releasePolicy === "private_scope_plus_one"
          ? { deliverySemantics: "system_config_confirmation" as const }
          : {}),
        replyGate: gate
      }, {
        conversationId: gate.conversationId,
        correlationId: input.correlationId
      })
    })
  };
}
