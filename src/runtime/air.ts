import { nanoid } from "nanoid";
import {
  AIR_CONVERSATION_VARIABLE,
  AIR_INSIGHT_VARIABLE,
  AIR_KNOWLEDGE_PROMPT_ID,
  AIR_KNOWLEDGE_VARIABLE,
  readAirKnowledge,
  replaceAirKnowledge,
  type AirConversationContext
} from "../../services/air/public.js";
import { loadPersona } from "../../services/agent/public.js";
import type { AgentPersona } from "../../services/agent/persona.js";
import type {
  ReadAirToolInput,
  ReadAirToolPort
} from "../../services/tools/public.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import type { ChatMessage, ConversationRecord, ParsedIncomingMessage } from "../types.js";
import {
  auxiliaryModelSignal,
  auxiliaryProviderCompleteOptions
} from "./auxiliaryModelBudget.js";
import { errorMessage } from "./infrastructure.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import type { RuntimePromptPort } from "./runtimeContracts.js";

const READ_AIR_MAX_ATTEMPTS = 2;
const READ_AIR_MESSAGE_LIMIT = 64;
const READ_AIR_MESSAGE_MAX_CHARS = 8_000;

interface RuntimeAirHost extends RuntimePromptPort {
  readonly conversationRecords: ReadonlyMap<string, ConversationRecord>;
  persona?: AgentPersona;
}

export class RuntimeAir {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: RuntimeAirHost) {}

  toolPort(incoming: ParsedIncomingMessage, messages: readonly ChatMessage[]): ReadAirToolPort {
    const conversationId = conversationRecordId(incoming);
    const record = this.host.conversationRecords.get(conversationId);
    const context: AirConversationContext = {
      conversationId,
      scope: incoming.scope,
      title: record?.title ?? "",
      accountId: record?.accountId ?? incoming.accountId,
      groupId: incoming.groupId,
      userId: incoming.userId,
      messages
    };
    return {
      execute: (input, signal) => this.enqueue(input, context, signal)
    };
  }

  private enqueue(input: ReadAirToolInput, context: AirConversationContext, signal?: AbortSignal) {
    const operation = this.queue.then(() => this.update(input, context, signal));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async update(
    input: ReadAirToolInput,
    context: AirConversationContext,
    signal?: AbortSignal
  ): Promise<unknown> {
    const runId = `read-air:${nanoid()}`;
    const modelSignal = auxiliaryModelSignal(signal);
    try {
      for (let attempt = 1; attempt <= READ_AIR_MAX_ATTEMPTS; attempt += 1) {
        if (modelSignal.aborted) throw modelSignal.reason ?? new Error("read_air aborted");
        const current = await readAirKnowledge(this.host.config);
        const request = await this.host.renderPromptRequest(AIR_KNOWLEDGE_PROMPT_ID, {
          [AIR_KNOWLEDGE_VARIABLE]: current.content,
          [AIR_CONVERSATION_VARIABLE]: boundedConversation(context),
          [AIR_INSIGHT_VARIABLE]: input.insight
        });
        const next = await this.host.completePrompt(this.host.getProvider(), request, auxiliaryProviderCompleteOptions({
          signal: modelSignal,
          logContext: {
            conversationId: context.conversationId,
            runId,
            stage: "read_air",
            promptFamily: AIR_KNOWLEDGE_PROMPT_ID,
            attempt
          }
        }));
        const committed = await replaceAirKnowledge(
          this.host.config,
          current.revision,
          next,
          modelSignal
        );
        if (committed.status === "conflict") continue;
        if (committed.status === "updated") this.host.persona = await loadPersona(this.host.config);
        await appendRequestLog({
          category: "runtime.action",
          action: "air.knowledge.updated",
          request: {
            scope: context.scope,
            insightChars: input.insight.length,
            messageCount: context.messages.length,
            attempt
          },
          response: {
            updated: committed.status === "updated",
            byteLength: Buffer.byteLength(committed.current.content, "utf8"),
            revision: committed.current.revision
          },
          metadata: { conversationId: context.conversationId, runId, stage: "read_air" }
        });
        return {
          ok: true,
          updated: committed.status === "updated",
          revision: committed.current.revision,
          message: committed.status === "updated" ? "场域知识已更新。" : "场域知识无需修改。"
        };
      }
      return {
        ok: false,
        code: "READ_AIR_CONFLICT",
        error: "AIR.md changed while read_air was updating it. Call read_air again."
      };
    } catch (error) {
      await appendRequestLog({
        category: "runtime.error",
        action: "air.knowledge.update_failed",
        request: { scope: context.scope, insightChars: input.insight.length },
        response: { error: errorMessage(error) },
        metadata: { conversationId: context.conversationId, runId, stage: "read_air" }
      }).catch(() => undefined);
      return { ok: false, code: "READ_AIR_FAILED", error: errorMessage(error) };
    }
  }
}

function boundedConversation(context: AirConversationContext) {
  return {
    schemaVersion: 1,
    conversation: {
      id: context.conversationId,
      scope: context.scope,
      title: context.title,
      ...(context.accountId ? { accountId: context.accountId } : {}),
      ...(context.groupId == null ? {} : { groupId: context.groupId }),
      ...(context.userId == null ? {} : { userId: context.userId })
    },
    messages: context.messages.slice(-READ_AIR_MESSAGE_LIMIT).map((message) => ({
      role: message.role,
      content: message.content.slice(0, READ_AIR_MESSAGE_MAX_CHARS)
    }))
  };
}
