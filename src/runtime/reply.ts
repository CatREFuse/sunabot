import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  AppConfig,
  AssistantMessageOrigin,
  ChatMessage,
  ConversationMessageQuote,
  ConversationRecord,
  ImageResult,
  ParsedIncomingMessage,
  ReasoningEffort
} from "../types.js";
import { resolveModelReasoningEffort } from "../admin/models.js";
import { AttachmentService } from "../../services/media/attachments/service.js";
import type {
  AttachmentExtractionContext,
  ParsedAttachment
} from "../../services/media/attachments/types.js";
import { CommandRouter, type CommandMatch } from "../../services/messaging/commandRouter.js";
import { isAdminSender } from "../../services/messaging/replySenderPolicy.js";
import { getDefaultProvider, getRootDir, getWorkspacePath, resolveProjectPath } from "../config.js";
import {
  assistantReplyEnvelope,
  decodeAssistantReply,
  decodeIncomingReply,
  decodeToolCompletion,
  incomingReplyEnvelope,
  noReplyPokeEnvelope,
  type AssistantReplyOutboxEnvelope,
  type AssistantReplyOutboxPayload,
  type RuntimeIncomingReplyEventPayload
} from "../../packages/contracts/session/runtimeMessages.js";
import { applicationDataStore, sqliteMemoryPersistence } from "../../adapters/sqlite/applicationDataStore.js";
import { configureMemoryPersistence } from "../../services/memory/persistence.js";
import {
  ReplyGateEpochs,
  isOrchestratorReplyRateLimited,
  resolveUserGroupReplyRoute,
  type ReplyGateSnapshot
} from "../../services/orchestration/groupReplyPolicy.js";
import { serializeUserGroupOrchestratorResult } from "../../services/orchestration/userGroupOrchestratorResult.js";
import { HookBus } from "../../services/messaging/hookBus.js";
import {
  applyMemoryBatchTransaction,
  ensureAgentTextFile,
  formatMemoryMatchesForPrompt,
  isMemoryBatchCommitted,
  mergeUserProfileMemory,
  normalizeEventMemorySchema,
  readAgentTextFile,
  readMemorySourceEntries,
  readUserProfileForUser,
  readWorkingMemorySnapshot,
  recallMemory,
  recoverMemoryTransactions,
  replaceWorkingMemoryFacts,
  resolveUserAddressName,
  type MemoryEntry,
  type MemoryFactInput
} from "../../services/memory/memoryService.js";
import {
  MemorySchedulerStore,
  type MemoryClaim,
  type MemoryQueuedMessage
} from "../../services/memory/memoryScheduler.js";
import { OpenAIProvider, type ProviderBashOptions, type ProviderCompleteOptions, type ProviderDeferredTurn } from "../../adapters/model/openaiProvider.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";
import {
  inboundImageUrls,
  replaceInboundImageUrls,
  type MessageDetailsV1,
  type MessagingPort,
  type OutboundMessageV1
} from "../../packages/contracts/messaging/messages.js";
import {
  generatedImageMediaAsset,
  imageMediaAsset,
  type AttachmentSourcePort
} from "../../packages/contracts/media/media.js";
import { loadPersona, AgentPersona } from "../../services/agent/persona.js";
import { appendRequestLog } from "../requestLog.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { SenderNameResolver, senderDisplayName, senderIdentity } from "../../services/conversations/senderName.js";
import type { SelfieInput, SelfieRunResult } from "../../services/tools/selfieTool.js";
import { cleanupPersistedCodexProcess, CodexToolRunner } from "../../adapters/codex/codexTool.js";
import { isTrustedQqFakeIp } from "../../adapters/onebot/qqMedia.js";
import type { CodexRunner } from "../../packages/contracts/tools/codex.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type SessionHandleResult
} from "../../services/sessions/sessionCoordinator.js";
import { SessionStore, type OutboxRecord, type SessionEventRecord, type ToolJobRecord } from "../../services/sessions/sessionStore.js";
import { TOOL_CALL_TIMEOUT_MS } from "../../services/tools/tools.js";
import {
  GENERATE_IMG_TOOL_NAME,
  generateImgMediaHandle,
  runGenerateImg,
  type GenerateImgReferenceContext
} from "../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../services/tools/selfieTool.js";
import { DISPATCH_MESSAGE_MAX_CHARS } from "../../services/tools/deferredDispatch.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent as defaultFinalPromptContent } from "../../services/agent/promptDefaults.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  type PromptVariableValue,
  type RenderedPromptRequest
} from "../../services/agent/promptSystem.js";
import { buildCommonPromptVariables, buildConversationPromptVariables } from "../../services/agent/persona.js";
import {
  applyRuntimeAgentExtensionPrompt,
  collectRuntimeAgentExtensionBatchTexts,
  parseExplicitSkillSelections
} from "./agentExtensions.js";
import { emojiPromptVariables, prepareRuntimeEmojiText } from "./emojiReply.js";
import { currentPromptInputMessage, serializeGroupThreadPromptContext } from "./groupThreadPipeline.js";
import { DEFAULT_CONTEXT_MESSAGE_LIMIT, MAX_STORED_CONVERSATION_MESSAGES, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES, MAX_CURRENT_CONTEXT_IMAGES, MAX_HISTORY_CONTEXT_IMAGES, HYDRATE_MESSAGE_WINDOW_MS, ACTIVE_CONVERSATION_WINDOW_MS, DIRECT_REPLY_TIMEOUT_MS, AMBIENT_ORCHESTRATOR_TIMEOUT_MS, ORCHESTRATOR_MAX_RETRIES, PREPARE_TIMEOUT_MS, RECENT_CONTEXT_TOKEN_BUDGET, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_COMMAND, CONVERSATION_REPLY_PROMPT_FILE, SELFIE_PROMPT_FILE, GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_PERSONA_FILES, ADMIN_RUNTIME_PROMPT_DEFAULTS, BatchUserInfo, WorkingMemoryMergeOutput, WorkingMemoryMergeContext, personaFileNameForAdminId, AdminIdentity, ConversationReplyUpdateInput, RuntimeCommandContext, ReplyDeliveryDraft, ReplyDelivery, DeferredCodexTurn, AmbientReplyJob, AmbientReplyState, AmbientIdleTimer, RuntimeConfigSnapshot, RuntimePromptSnapshot, SunaRuntimeOptions } from "./runtimeContracts.js";
import { buildMemoryPromptVariables, buildUserProfileRecallQuery, buildUserPrompt, buildWorkingMemoryRecallQuery, clampInteger, collectGroupChatSummaryMessages, estimatePromptTokens, isAdminUserId, toContextChatMessage, uniqueMemoryEntries } from "./conversationMemoryHelpers.js";
import { conversationMessageAttachments, conversationRecordId, queueIncomingSnapshot, selectRelevantConversationAttachments, toConversationQuote, uniqueAttachments, uniqueQuotes, uniqueStrings } from "./messagingAttachmentHelpers.js";
import { errorMessage, isAbortError, isRuntimeIncomingMessage, sanitizeErrorDetail } from "./infrastructure.js";
import { providerWorkbenchFilesForIncoming } from "./workbenchFiles.js";
import {
  runtime_attachReplyReferences,
  runtime_buildRecentContextMessages,
  runtime_contextMessageLimit,
  runtime_generateImgReferenceContext,
  runtime_groupReplyOptions,
  runtime_isAdminUser,
  runtime_loadMessageDetails,
  runtime_loadQuoteReferences,
  runtime_refreshAttachmentCacheReferences,
  runtime_retainedConversationMessageLimit,
  runtime_resolveProviderBashHandle,
  runtime_selectRelevantAttachments
} from "./replyContext.js";
import { ReplyDebounceContext, resolveReplyContextCaptureSequence, type ReplyDebounceContextOptions } from "./replyDebounceContext.js";
import { runtime_replyToToolCompletion } from "./replyDebounceDispatch.js";
import { sendRuntimeVoiceFinalReply, startRuntimeDeferredVoiceSynthesis } from "./voiceReply.js";
import * as systemConfigReply from "./systemConfigReply.js";

export { runtime_replyToToolCompletion };
export {
  runtime_attachReplyReferences,
  runtime_buildRecentContextMessages,
  runtime_contextMessageLimit,
  runtime_generateImgReferenceContext,
  runtime_groupReplyOptions,
  runtime_isAdminUser,
  runtime_loadMessageDetails,
  runtime_loadQuoteReferences,
  runtime_refreshAttachmentCacheReferences,
  runtime_retainedConversationMessageLimit,
  runtime_resolveProviderBashHandle,
  runtime_selectRelevantAttachments
};
import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;
export async function runtime_replyToIncoming(this: RuntimeHost,
    channelKey: string,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    options: ReplyDebounceContextOptions & {
      isCurrent?: () => boolean;
      delivery?: ReplyDelivery;
      onDeferred?: (value: DeferredCodexTurn) => void;
      allowAsyncCodex?: boolean;
      allowAsyncImage?: boolean;
      allowImageTools?: boolean;
      promptOverride?: string;
      messageOrigin?: AssistantMessageOrigin;
      seedToolNames?: readonly string[];
    } = {}
  ) {
    const provider = this.getProvider();
    const persona = this.persona ?? (await loadPersona(this.config));
    const admin = this.adminIdentity();
    const isAdmin = isAdminUserId(incoming.userId, admin);
    const promptId = incoming.scope === "private"
      ? "conversation.private-reply"
      : "conversation.group-reply";
    const logRunId = nanoid();
    const debounceContext = new ReplyDebounceContext(this, incoming, options);
    const logContext = {
      conversationId: conversationRecordId(incoming),
      incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
      runId: logRunId,
      stage: "reply",
      promptFamily: promptId
    };
    let sent = false;
    let requestStarted = false;
    let systemConfigLifecycle: systemConfigReply.SystemConfigReplyLifecycle | undefined;
    const usedToolNames = new Set(options.seedToolNames ?? []);
    const currentToolNames = () => [...usedToolNames];
    const finalizeToolNames = () => {
      const toolNames = currentToolNames();
      for (const draft of options.delivery?.outbox ?? []) {
        const payload = draft.payload.payload;
        if (payload.type !== "assistant_reply") continue;
        if (payload.logRunId !== logRunId) continue;
        payload.toolNames = toolNames.length ? [...toolNames] : undefined;
      }
      this.recordAssistantTurnTools(incoming, logRunId, toolNames);
      return toolNames;
    };
    try {
      const beforeContext = await this.hooks.run("before_context", {
        channel: channelKey,
        text: options.promptOverride ?? incoming.text,
        context: { scope: incoming.scope, userId: incoming.userId, groupId: incoming.groupId, isAdmin }
      });
      const threadContext = await debounceContext.prepareThreadContext();
      const threadPromptContext = this.groupThreadPromptContext(threadContext);
      const exactUserProfile = await readUserProfileForUser(this.config, String(incoming.userId));
      const memoryResult = await recallMemory(this.config, {
        query: beforeContext.text,
        source: "long_term",
        limit: 8
      });
      const longTermMemoryMatches = memoryResult.ok ? memoryResult.matches : [];
      const workingMemoryResult = await recallMemory(this.config, {
        query: buildWorkingMemoryRecallQuery(incoming, beforeContext.text),
        source: "working",
        limit: 8
      });
      const workingMemoryMatches = workingMemoryResult.ok ? workingMemoryResult.matches : [];
      const userProfileResult = await recallMemory(this.config, {
        query: buildUserProfileRecallQuery(incoming, beforeContext.text, admin),
        source: "user_profile",
        limit: 6
      });
      const userProfileMemoryMatches = userProfileResult.ok ? userProfileResult.matches : [];
      const currentUserProfileMemoryMatches = uniqueMemoryEntries([
        ...(exactUserProfile ? [exactUserProfile] : []),
        ...userProfileMemoryMatches
      ]);
      const memoryMatches = uniqueMemoryEntries([
        ...workingMemoryMatches,
        ...longTermMemoryMatches,
        ...currentUserProfileMemoryMatches
      ]);
      await appendRequestLog({
        category: "runtime.action",
        action: "memory.recall.before_reply",
        request: {
          longTermQuery: beforeContext.text,
          workingQuery: buildWorkingMemoryRecallQuery(incoming, beforeContext.text),
          userProfileQuery: buildUserProfileRecallQuery(incoming, beforeContext.text, admin)
        },
        response: {
          workingCount: workingMemoryMatches.length,
          longTermCount: longTermMemoryMatches.length,
          userProfileCount: userProfileMemoryMatches.length,
          exactUserProfile: Boolean(exactUserProfile),
          mergedCount: memoryMatches.length
        },
        metadata: logContext
      });
      const afterContext = await this.hooks.run("after_context", {
        channel: channelKey,
        text: beforeContext.text,
        context: {
          scope: incoming.scope,
          userId: incoming.userId,
          groupId: incoming.groupId,
          isAdmin,
          workingMemoryMatches: workingMemoryMatches.map((item) => ({
            id: item.id,
            text: item.text,
            score: item.score
          })),
          longTermMemoryMatches: longTermMemoryMatches.map((item) => ({
            id: item.id,
            text: item.text,
            score: item.score
          })),
          userProfileMemoryMatches: currentUserProfileMemoryMatches.map((item) => ({
            id: item.id,
            text: item.text,
            score: item.score
          }))
        }
      });
      const attachmentContext = await debounceContext.buildAttachmentContext(afterContext.text);
      const basePrompt = options.promptOverride
        ? [afterContext.text, attachmentContext.text].filter(Boolean).join("\n\n")
        : buildUserPrompt(
          incoming,
          afterContext.text,
          isAdmin,
          admin,
          attachmentContext.text
        );
      const prompt = debounceContext.buildCurrentPrompt(basePrompt, Boolean(options.promptOverride));
      const messages64 = this.buildRecentContextMessages(incoming, debounceContext.historyCaptureSequence, 64);
      const conversationMessages = this.buildRecentContextMessages(incoming, debounceContext.historyCaptureSequence), markerId = nanoid();
      const currentInputMarker = incoming.scope === "private" ? undefined : { start: `\uE000sunabot-current-input:${markerId}:start\uE001`, end: `\uE000sunabot-current-input:${markerId}:end\uE001` };
      const voiceSnapshot = await this.voiceSnapshot();
      let promptRequest = await this.renderPromptRequest(promptId, {
        ...buildCommonPromptVariables(this.config, { scope: incoming.scope,
          userName: senderDisplayName(incoming.sender) || String(incoming.userId) }),
        ...buildConversationPromptVariables(this.config),
        ...emojiPromptVariables(this.config),
        ...voiceSnapshot.variables,
        ...buildMemoryPromptVariables({ working: workingMemoryMatches,
          longTerm: longTermMemoryMatches, userProfile: currentUserProfileMemoryMatches }),
        "messages_64": messages64,
        "conversation.messages": conversationMessages,
        ...(incoming.scope === "private" ? {} : { "conversation.group.thread_context": serializeGroupThreadPromptContext(threadPromptContext), "conversation.group.orchestrator_result": serializeUserGroupOrchestratorResult(options.orchestratorResult) }),
        "user.input": currentInputMarker ? `${currentInputMarker.start}${prompt}${currentInputMarker.end}` : prompt
      });
      const extensionBatchTexts = options.promptOverride === undefined
        ? collectRuntimeAgentExtensionBatchTexts({
          record: this.conversationRecords.get(conversationRecordId(incoming)),
          conversationId: conversationRecordId(incoming),
          triggeringUserId: incoming.userId,
          captureSequence: options.captureSequence,
          contextThroughSequence: options.contextThroughSequence,
          fallbackText: incoming.text
        })
        : [];
      const runtimeAgentExtensions = options.promptOverride === undefined
        ? await this.agentExtensions?.prepare({
          agentId: this.config.persona.defaultAgentId,
          conversationId: conversationRecordId(incoming),
          accountId: incoming.accountId ?? "primary",
          transport: incoming.transport === "web" ? "web" : "onebot",
          userId: incoming.userId,
          confirmationTexts: extensionBatchTexts,
          selectedSkillIds: parseExplicitSkillSelections(extensionBatchTexts),
          canApproveMcpTools: isAdmin,
          signal: options.signal
        })
        : undefined;
      if (runtimeAgentExtensions?.requiredMcpFailures.length) {
        throw Object.assign(new Error("所需 MCP 服务暂不可用。"), {
          code: "AGENT_REQUIRED_MCP_UNAVAILABLE"
        });
      }
      promptRequest = applyRuntimeAgentExtensionPrompt(promptRequest, runtimeAgentExtensions);
      systemConfigLifecycle = systemConfigReply.createSystemConfigReplyLifecycle(
        this, incoming, isAdmin, options.promptOverride, promptRequest
      );
      const currentUserMessage = currentPromptInputMessage(promptRequest, currentInputMarker);
      if (currentUserMessage) {
        currentUserMessage.imageUrls = debounceContext.currentImageUrls().slice(0, MAX_CURRENT_CONTEXT_IMAGES);
        currentUserMessage.localImagePaths = attachmentContext.localImagePaths;
      }
      const selfieChatReferenceImageUrls = this.collectSelfieChatReferenceImages(incoming, debounceContext.contextCaptureSequence);
      const generateImgReferenceContext = runtime_generateImgReferenceContext.call(
        this,
        incoming,
        debounceContext.contextCaptureSequence
      );
      const generatedImages: ImageResult[] = [];
      let assistantTextCount = 0;
      this.recordAssistantRequestStarted(incoming, logRunId);
      requestStarted = true;
      await appendRequestLog({
        category: "runtime.action",
        action: "reply.started",
        request: {
          scope: incoming.scope,
          userId: incoming.userId,
          groupId: incoming.groupId
        },
        response: { status: "running" },
        metadata: logContext
      });
      const toolCapabilities = await this.resolveToolCapabilities(null);
      const bash = await this.resolveProviderBashHandle(incoming, options.promptOverride);
      const turn = await this.completePromptTurn(provider, promptRequest, {
        signal: options.signal,
        modelRequestMaxRetries: this.config.normalReply.maxRetries,
        allowNoReply: true,
        workbenchFiles: providerWorkbenchFilesForIncoming(this.config, incoming, options.promptOverride),
        bash,
        conversationAssets: this.conversationAssetProviderOptions(
          incoming,
          gateway,
          logRunId,
          options.isCurrent,
          options.delivery
        ),
        voice: this.voiceProviderCapability(voiceSnapshot.profile, incoming, gateway, options.delivery),
        bot: this.config.bot,
        disabledTools: this.conversationRecords.get(conversationRecordId(incoming))?.disabledTools,
        generateImage: (prompt, size, quality, referenceImageUrls, childLogContext) => provider.generateImage(
          prompt,
          size,
          quality,
          referenceImageUrls,
          childLogContext ?? logContext
        ),
        onAssistantText: async (text, source = "text") => {
          if (options.isCurrent && !options.isCurrent()) return;
          const quoteReply = assistantTextCount === 0;
          assistantTextCount += 1;
          const record = await this.sendAssistantReply(
            channelKey,
            incoming,
            gateway,
            text,
            isAdmin,
            [],
            logRunId,
            options.isCurrent,
            options.delivery,
            quoteReply,
            {
              messageOrigin: source === "assistant_text"
                ? "assistant_text"
                : options.messageOrigin ?? "text",
              toolNames: currentToolNames()
            },
            "immediate",
            options.signal
          );
          if (record) sent = true;
        },
        onToolCall: (name) => {
          usedToolNames.add(name);
        },
        onImageGenerated: (image) => {
          generatedImages.push(image);
        },
        referenceImageUrls: inboundImageUrls(incoming),
        imageReferences: generateImgReferenceContext,
        memory: {
          enabled: true,
          recall: (input) => recallMemory(this.config, input)
        },
        selfie: {
          enabled: true,
          referenceImageUrls: selfieChatReferenceImageUrls,
          run: (input) => this.runSelfie(input, provider, {
            chatReferenceImageUrls: selfieChatReferenceImageUrls,
            imageReferences: generateImgReferenceContext,
            logContext
          })
        },
        asyncCodex: (options.allowAsyncCodex ?? true)
          && this.config.bot.tools.codex.enabled
          && toolCapabilities.codex,
        asyncImage: options.allowAsyncImage ?? true,
        imageTools: options.allowImageTools ?? true,
        systemConfig: systemConfigLifecycle?.toolPort, cron: this.scheduledTasks.toolPort(incoming, isAdmin, options.promptOverride),
        skills: runtimeAgentExtensions?.skills,
        mcp: runtimeAgentExtensions?.mcp,
        logContext
      });
      if (turn.kind === "deferred") usedToolNames.add(turn.toolCall.name);
      const turnToolNames = finalizeToolNames();
      if (turn.kind !== "completed") systemConfigLifecycle?.discard();
      if (options.isCurrent && !options.isCurrent()) {
        systemConfigLifecycle?.discard();
        return sent;
      }
      if (turn.kind === "no_reply") {
        this.discardAssistantRequest(incoming, logRunId);
        if (options.delivery) options.delivery.terminalStatus = "no_reply";
        if (this.config.bot.pokeOnNoReply && gateway.poke) {
          const target = {
            ...(incoming.accountId ? { accountId: incoming.accountId } : {}),
            userId: incoming.userId,
            ...(incoming.groupId ? { groupId: incoming.groupId } : {})
          };
          if (options.delivery) {
            const dedupeKey = incoming.messageId == null
              ? undefined
              : `no-reply-poke:${incoming.accountId ?? "primary"}:${incoming.messageId}`;
            options.delivery.outbox.push({
              kind: "onebot.poke",
              payload: noReplyPokeEnvelope({
                type: "no_reply_poke",
                incoming: queueIncomingSnapshot(incoming),
                logRunId,
                replyGate: this.replyGates.capture(incoming.scope, conversationRecordId(incoming))
              }, {
                conversationId: conversationRecordId(incoming),
                correlationId: logRunId,
                idempotencyKey: dedupeKey
              }),
              dedupeKey
            });
          } else {
            try {
              await gateway.poke(target);
            } catch (error) {
              await appendRequestLog({
                category: "runtime.action",
                action: "reply.no_reply.poke.failed",
                request: target,
                response: { error: sanitizeErrorDetail(errorMessage(error)) },
                metadata: logContext
              });
            }
          }
        }
        await appendRequestLog({
          category: "runtime.action",
          action: "reply.no_reply",
          request: {
            scope: incoming.scope,
            userId: incoming.userId,
            groupId: incoming.groupId
          },
          response: { status: "no_reply" },
          metadata: logContext
        });
        return sent;
      }
      if (turn.kind === "deferred") {
        void startRuntimeDeferredVoiceSynthesis(this, turn.voice,
          { incoming, gateway, logRunId, isCurrent: options.isCurrent, delivery: options.delivery, signal: options.signal });
        const acknowledgement = turn.acknowledgement.trim();
        if (!acknowledgement) throw new Error("异步工具缺少 dispatch_message。");
        const preparedAcknowledgement = await prepareRuntimeEmojiText(acknowledgement, this.config,
          (value) => this.rewriteToneText(value, { incoming, signal: options.signal, logContext }));
        if (preparedAcknowledgement.text.length > DISPATCH_MESSAGE_MAX_CHARS) {
          throw new Error(`Tone 处理后的 dispatch_message 不能超过 ${DISPATCH_MESSAGE_MAX_CHARS} 个字符。`);
        }
        const originalRequest = {
          incoming: queueIncomingSnapshot(incoming),
          captureSequence: options.captureSequence,
          contextThroughSequence: options.contextThroughSequence,
          imageReferences: generateImgReferenceContext,
          replyGate: this.replyGates.capture(incoming.scope, conversationRecordId(incoming)),
          ...(options.delivery?.replyQuote ? { replyQuote: options.delivery.replyQuote } : {}),
          ...(threadContext ? { threadContext } : {}),
          ...(options.orchestratorResult ? { orchestratorResult: options.orchestratorResult } : {})
        };
        options.onDeferred?.({
          deferred: turn,
          originalRequest,
          acknowledgement: this.replyDeliveryDraft(
            incoming,
            preparedAcknowledgement.text,
            isAdmin,
            preparedAcknowledgement.images,
            logRunId,
            `tool-ack:${turn.toolCall.name}:${turn.toolCall.callId}`,
            true,
            {
              messageOrigin: "async_tool_dispatch",
              toolNames: turnToolNames
            },
            options.delivery?.replyQuote,
            preparedAcknowledgement.contentSegments
          )
        });
        return sent;
      }
      const finalReply = {
        lifecycle: systemConfigLifecycle,
        channelKey, incoming, gateway, text: turn.text, isAdmin,
        generatedImages, logRunId, isCurrent: options.isCurrent,
        delivery: options.delivery,
        signal: options.signal,
        messageOrigin: turn.messageOrigin ?? options.messageOrigin ?? "text",
        toolNames: turnToolNames
      };
      sent = await (turn.voice ? sendRuntimeVoiceFinalReply(this, { ...finalReply, voice: turn.voice })
        : systemConfigReply.sendSystemConfigAwareFinalReply(this, finalReply)) || sent;
      return sent;
    } catch (error) {
      systemConfigLifecycle?.discard();
      const failedToolNames = finalizeToolNames();
      const failure = options.signal?.reason ?? error;
      const aborted = options.signal?.aborted || isAbortError(error);
      await appendRequestLog({
        category: "runtime.action",
        action: aborted ? "reply.cancelled" : "reply.failed",
        response: {
          ok: false,
          error: sanitizeErrorDetail(errorMessage(failure))
        },
        metadata: logContext
      });
      if (aborted) {
        if (requestStarted) {
          const timedOut = /timed out|timeout/i.test(errorMessage(failure));
          this.recordAssistantMessage(
            incoming,
            timedOut ? "请求超时，请查看请求日志。" : "请求已取消。",
            [],
            logRunId,
            "failed",
            {
              messageOrigin: options.messageOrigin ?? "text",
              toolNames: failedToolNames
            }
          );
        }
        return sent;
      }
      console.error("[runtime] reply failed", {
        channel: channelKey,
        messageId: incoming.messageId,
        userId: incoming.userId,
        groupId: incoming.groupId,
        error
      });
      if (systemConfigReply.shouldSuppressSystemConfigFailureReply(error)) return sent;
      if (!options.isCurrent || options.isCurrent()) {
        await this.sendErrorReply(
          incoming,
          gateway,
          error,
          options.isCurrent,
          logRunId,
          options.delivery,
          {
            messageOrigin: options.messageOrigin ?? "text",
            toolNames: failedToolNames
          },
          options.signal
        );
      }
      return sent;
    }
  }
export async function runtime_replyWithGroupChatSummary(this: RuntimeHost,
    channelKey: string,
    incoming: ParsedIncomingMessage,
    gateway: MessagingPort,
    signal?: AbortSignal,
    isCurrent: () => boolean = () => true,
    delivery?: ReplyDelivery,
    contextThroughSequence?: number
  ) {
    const admin = this.adminIdentity();
    const isAdmin = isAdminUserId(incoming.userId, admin);

    try {
      if (!incoming.groupId) {
        const record = await this.sendAssistantReply(
          channelKey, incoming, gateway, "只能在群聊里总结群聊。", isAdmin, [], undefined, isCurrent, delivery,
          true, { messageOrigin: "text" }, "buffered", signal
        );
        if (record) this.scheduleMemoryCompression(record);
        return;
      }

      const record = this.conversationRecords.get(conversationRecordId(incoming));
      const summaryMessages = collectGroupChatSummaryMessages(
        record,
        incoming,
        contextThroughSequence
      );
      if (!summaryMessages.length) {
        const replyRecord = await this.sendAssistantReply(
          channelKey, incoming, gateway, "最近 6 小时没有可总结的文字消息。", isAdmin, [], undefined, isCurrent, delivery,
          true, { messageOrigin: "text" }, "buffered", signal
        );
        if (replyRecord) this.scheduleMemoryCompression(replyRecord);
        return;
      }

      const provider = this.getProvider();
      const now = new Date();
      const payload = {
        command: GROUP_CHAT_SUMMARY_COMMAND,
        conversation: {
          id: record?.id ?? conversationRecordId(incoming),
          scope: incoming.scope,
          title: record?.title ?? String(incoming.groupId),
          groupId: incoming.groupId,
          windowHours: 6,
          windowStart: new Date(now.getTime() - GROUP_CHAT_SUMMARY_WINDOW_MS).toISOString(),
          windowEnd: now.toISOString(),
          messageCount: summaryMessages.length
        },
        messages: summaryMessages
      };
      const promptRequest = await this.renderPromptRequest("conversation.group-summary", {
        "group.payload": payload
      });
      const reply = await this.completePrompt(provider, promptRequest, {
        signal,
        logContext: {
          conversationId: record?.id ?? conversationRecordId(incoming),
          incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
          stage: "reply",
          promptFamily: "conversation.group-summary"
        }
      });
      const replyRecord = await this.sendAssistantReply(
        channelKey, incoming, gateway, reply, isAdmin, [], undefined, isCurrent, delivery,
        true, { messageOrigin: "text" }, "buffered", signal
      );
      if (replyRecord) this.scheduleMemoryCompression(replyRecord);
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) return;
      console.error("[runtime] group chat summary failed", {
        channel: channelKey,
        messageId: incoming.messageId,
        userId: incoming.userId,
        groupId: incoming.groupId,
        error
      });
      await this.sendErrorReply(incoming, gateway, error, isCurrent, undefined, delivery, { messageOrigin: "text" }, signal);
    }
  }
export async function runtime_processDeferredToolJob(this: RuntimeHost, job: ToolJobRecord, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason ?? new Error("异步工具任务已取消。");
    const originalRequest = job.originalRequest as {
      incoming?: unknown;
      captureSequence?: unknown;
      contextThroughSequence?: unknown;
      imageReferences?: unknown;
    };
    const incoming = originalRequest.incoming;
    if (!isRuntimeIncomingMessage(incoming)) {
      return { status: "failed" as const, error: { message: "异步图片任务缺少原始请求。" } };
    }
    const provider = this.getProvider();
    const logContext = {
      conversationId: conversationRecordId(incoming),
      incomingMessageId: incoming.messageId == null ? undefined : String(incoming.messageId),
      runId: job.id,
      stage: "async_image_tool"
    };
    const input = job.arguments && typeof job.arguments === "object" && !Array.isArray(job.arguments)
      ? job.arguments as Record<string, unknown>
      : {};
    const captureSequence = resolveReplyContextCaptureSequence(
      originalRequest.captureSequence, originalRequest.contextThroughSequence
    );
    const imageReferences = readGenerateImgReferenceContext(originalRequest.imageReferences) ??
      runtime_generateImgReferenceContext.call(this, incoming, captureSequence);
    const result = job.toolName === GENERATE_IMG_TOOL_NAME
      ? await runGenerateImg(input, this.config.bot, (prompt, size, quality, referenceImageUrls, childLogContext) =>
          provider.generateImage(prompt, size, quality, referenceImageUrls, childLogContext ?? logContext), {
          referenceImageUrls: inboundImageUrls(incoming),
          imageReferences,
          logContext
        })
      : job.toolName === SELFIE_TOOL_NAME
        ? await this.runSelfie(input, provider, {
            chatReferenceImageUrls: this.collectSelfieChatReferenceImages(incoming, captureSequence),
            imageReferences,
            logContext
          })
        : { ok: false, error: `不支持的异步工具：${job.toolName}` };
    const record = result as { ok?: unknown; error?: unknown };
    return record.ok === true
      ? { status: "succeeded" as const, result }
      : { status: "failed" as const, result, error: { message: String(record.error ?? "图片生成失败。") } };
  }

function readGenerateImgReferenceContext(value: unknown): GenerateImgReferenceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const mediaByHandleValue = record.mediaByHandle;
  const mediaByHandle = mediaByHandleValue && typeof mediaByHandleValue === "object" && !Array.isArray(mediaByHandleValue)
    ? Object.fromEntries(Object.entries(mediaByHandleValue)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())))
    : {};
  return {
    currentImageUrls: readReferenceImageUrls(record.currentImageUrls),
    previousOutputImageUrls: readReferenceImageUrls(record.previousOutputImageUrls),
    historyImageUrls: readReferenceImageUrls(record.historyImageUrls),
    mediaByHandle
  };
}

function readReferenceImageUrls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))
    .slice(0, 4);
}
export class RuntimeReply {
  constructor(private readonly host: RuntimeHost) {}
  replyToIncoming(...args: Parameters<typeof runtime_replyToIncoming>) { return runtime_replyToIncoming.call(this.host, ...args); }
  replyWithGroupChatSummary(...args: Parameters<typeof runtime_replyWithGroupChatSummary>) { return runtime_replyWithGroupChatSummary.call(this.host, ...args); }
  replyToToolCompletion(...args: Parameters<typeof runtime_replyToToolCompletion>) { return runtime_replyToToolCompletion.call(this.host, ...args); }
  processDeferredToolJob(...args: Parameters<typeof runtime_processDeferredToolJob>) { return runtime_processDeferredToolJob.call(this.host, ...args); }
  attachReplyReferences(...args: Parameters<typeof runtime_attachReplyReferences>) { return runtime_attachReplyReferences.call(this.host, ...args); }
  loadMessageDetails(...args: Parameters<typeof runtime_loadMessageDetails>) { return runtime_loadMessageDetails.call(this.host, ...args); }
  loadQuoteReferences(...args: Parameters<typeof runtime_loadQuoteReferences>) { return runtime_loadQuoteReferences.call(this.host, ...args); }
  selectRelevantAttachments(...args: Parameters<typeof runtime_selectRelevantAttachments>) { return runtime_selectRelevantAttachments.call(this.host, ...args); }
  refreshAttachmentCacheReferences(...args: Parameters<typeof runtime_refreshAttachmentCacheReferences>) { return runtime_refreshAttachmentCacheReferences.call(this.host, ...args); }
  buildRecentContextMessages(...args: Parameters<typeof runtime_buildRecentContextMessages>) { return runtime_buildRecentContextMessages.call(this.host, ...args); }
  contextMessageLimit(...args: Parameters<typeof runtime_contextMessageLimit>) { return runtime_contextMessageLimit.call(this.host, ...args); }
  retainedConversationMessageLimit(...args: Parameters<typeof runtime_retainedConversationMessageLimit>) { return runtime_retainedConversationMessageLimit.call(this.host, ...args); }
  groupReplyOptions(...args: Parameters<typeof runtime_groupReplyOptions>) { return runtime_groupReplyOptions.call(this.host, ...args); }
  resolveProviderBashHandle(...args: Parameters<typeof runtime_resolveProviderBashHandle>) { return runtime_resolveProviderBashHandle.call(this.host, ...args); }
  isAdminUser(...args: Parameters<typeof runtime_isAdminUser>) { return runtime_isAdminUser.call(this.host, ...args); }
}
