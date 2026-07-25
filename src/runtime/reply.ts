import { nanoid } from "nanoid";
import {
  inboundImageUrls,
  type MessagingPort
} from "../../packages/contracts/messaging/messages.js";
import { noReplyPokeEnvelope } from "../../packages/contracts/session/runtimeMessages.js";
import { readCallbackInput } from "../../services/agent/callbackInput.js";
import { formatModelTimestamp, systemModelTimeZone } from "../../services/agent/modelTime.js";
import {
  buildCommonPromptVariables,
  buildConversationPromptVariables
} from "../../services/agent/persona.js";
import { senderDisplayName } from "../../services/conversations/senderName.js";
import { DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE } from "../../services/director/public.js";
import { searchKnowledge } from "../../services/knowledge/public.js";
import { readUserProfileForUser } from "../../services/memory/memoryService.js";
import { serializeUserGroupOrchestratorResult } from "../../services/orchestration/userGroupOrchestratorResult.js";
import type { ToolJobRecord } from "../../services/sessions/sessionStore.js";
import { DISPATCH_MESSAGE_MAX_CHARS } from "../../services/tools/deferredDispatch.js";
import {
  GENERATE_IMG_TOOL_NAME,
  runGenerateImg,
  type GenerateImgReferenceContext
} from "../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../services/tools/selfieTool.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import type { GeneratedImageMetadata } from "../../adapters/model/provider/contracts.js";
import type { SunaRuntime } from "../runtime.js";
import {
  type AssistantMessageOrigin,
  type ImageResult,
  type ParsedIncomingMessage
} from "../types.js";
import {
  applyRuntimeAgentExtensionPrompt,
  collectRuntimeAgentExtensionBatchTexts,
  parseExplicitSkillSelections
} from "./agentExtensions.js";
import {
  buildMemoryPromptVariables,
  buildUserProfileRecallQuery,
  buildUserPrompt,
  buildWorkingMemoryRecallQuery,
  collectGroupChatSummaryMessages,
  isAdminUserId,
  uniqueMemoryEntries
} from "./conversationMemoryHelpers.js";
import { emojiPromptVariables, prepareRuntimeEmojiText } from "./emojiReply.js";
import { currentPromptInputMessage, serializeGroupThreadPromptContext } from "./groupThreadPipeline.js";
import { errorMessage, isAbortError, isRuntimeIncomingMessage, sanitizeErrorDetail } from "./infrastructure.js";
import { ModelContextMemoryRecall } from "./memoryRecallExposure.js";
import { conversationRecordId, queueIncomingSnapshot, uniqueStrings } from "./messagingAttachmentHelpers.js";
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
  runtime_resolveProviderBashHandle,
  runtime_retainedConversationMessageLimit,
  runtime_selectRelevantAttachments
} from "./replyContext.js";
import { ReplyDebounceContext, resolveReplyContextCaptureSequence, type ReplyDebounceContextOptions } from "./replyDebounceContext.js";
import { runtime_replyToToolCompletion } from "./replyDebounceDispatch.js";
import {
  GROUP_CHAT_SUMMARY_COMMAND,
  GROUP_CHAT_SUMMARY_WINDOW_MS,
  MAX_CURRENT_CONTEXT_IMAGES,
  type DirectorReplyAccess,
  type DeferredCodexTurn,
  type ReplyDelivery
} from "./runtimeContracts.js";
import * as systemConfigReply from "./systemConfigReply.js";
import { sendRuntimeVoiceFinalReply, startRuntimeDeferredVoiceSynthesis } from "./voiceReply.js";
import { providerWorkbenchFilesForIncoming } from "./workbenchFiles.js";
import { providerChatMediaForIncoming } from "./chatMedia.js";
export { runtime_attachReplyReferences, runtime_buildRecentContextMessages, runtime_contextMessageLimit, runtime_generateImgReferenceContext, runtime_groupReplyOptions, runtime_isAdminUser, runtime_loadMessageDetails, runtime_loadQuoteReferences, runtime_refreshAttachmentCacheReferences, runtime_replyToToolCompletion, runtime_resolveProviderBashHandle, runtime_retainedConversationMessageLimit, runtime_selectRelevantAttachments };
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
      atomicImageReply?: boolean;
      directorAccess?: DirectorReplyAccess;
      promptOverride?: string;
      messageOrigin?: AssistantMessageOrigin;
      seedToolNames?: readonly string[];
    } = {}
  ) {
    const provider = this.getProvider();
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
      const modelContextMemory = new ModelContextMemoryRecall(this.config, logRunId);
      const memoryResult = await modelContextMemory.search({
        query: beforeContext.text,
        source: "long_term",
        limit: 8
      });
      const longTermMemoryMatches = memoryResult.ok ? memoryResult.matches : [];
      const workingMemoryResult = await modelContextMemory.search({
        query: buildWorkingMemoryRecallQuery(incoming, beforeContext.text),
        source: "working",
        limit: 8
      });
      const workingMemoryMatches = workingMemoryResult.ok ? workingMemoryResult.matches : [];
      const userProfileResult = await modelContextMemory.search({
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
      const basePrompt = options.promptOverride || readCallbackInput(afterContext.text)
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
      const directorContext = options.directorAccess === "none"
        ? ""
        : await this.director.promptContext();
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
        [DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE]: directorContext,
        ...(incoming.scope === "private" ? {} : { "conversation.group.thread_context": serializeGroupThreadPromptContext(threadPromptContext), "conversation.group.orchestrator_result": serializeUserGroupOrchestratorResult(options.orchestratorResult) }),
        "user.input": currentInputMarker ? `${currentInputMarker.start}${prompt}${currentInputMarker.end}` : prompt
      });
      modelContextMemory.includePromptVariable(promptRequest, "memory.long_term", longTermMemoryMatches);
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
      const selfieChatReferenceImageUrls = this.collectSelfieChatReferenceImages(
        incoming, debounceContext.contextCaptureSequence, debounceContext.historyCaptureSequence);
      const generateImgReferenceContext = runtime_generateImgReferenceContext.call(
        this, incoming, debounceContext.contextCaptureSequence, debounceContext.historyCaptureSequence);
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
      const [nativeBash, dockerBash] = await Promise.all([
        this.resolveProviderBashHandle(incoming, options.promptOverride, "native"),
        this.resolveProviderBashHandle(incoming, options.promptOverride, "docker")
      ]);
      const chatMediaEpoch = this.configEpoch;
      const chatMedia = providerChatMediaForIncoming(
        this.config,
        incoming,
        options.promptOverride,
        this.attachmentService.cache,
        () => (
          this.configEpoch === chatMediaEpoch
          && (!options.isCurrent || options.isCurrent())
          && !options.signal?.aborted
        )
      );
      const turn = await this.completePromptTurn(provider, promptRequest, {
        signal: options.signal,
        modelRequestMaxRetries: this.config.normalReply.maxRetries,
        allowNoReply: true,
        workbenchFiles: providerWorkbenchFilesForIncoming(this.config, incoming, options.promptOverride),
        chatMedia,
        bash: {
          ...(nativeBash ? { native: nativeBash } : {}),
          ...(dockerBash ? { docker: dockerBash } : {})
        },
        conversationAssets: options.atomicImageReply ? undefined : this.conversationAssetProviderOptions(
          incoming,
          gateway,
          logRunId,
          options.isCurrent,
          options.delivery
        ),
        voice: options.atomicImageReply ? undefined : this.voiceProviderCapability(voiceSnapshot.profile, incoming, gateway, options.delivery),
        bot: this.config.bot,
        disabledTools: this.conversationRecords.get(conversationRecordId(incoming))?.disabledTools,
        generateImage: (prompt, size, quality, referenceImageUrls, childLogContext) => provider.generateImage(
          prompt,
          size,
          quality,
          referenceImageUrls,
          childLogContext ?? logContext
        ),
        onAssistantText: options.atomicImageReply ? undefined : async (text, source = "text") => {
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
        onImageGenerated: (image, metadata) => {
          generatedImages.push(image);
          recordGeneratedImageHistory(this.config, image, metadata);
        },
        referenceImageUrls: inboundImageUrls(incoming),
        imageReferences: generateImgReferenceContext,
        memory: {
          enabled: true,
          recall: (input) => modelContextMemory.recall(input)
        },
        knowledge: {
          enabled: true,
          search: (input) => searchKnowledge(this.config, input)
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
        asyncCodex: !options.atomicImageReply && (options.allowAsyncCodex ?? true)
          && this.config.bot.tools.codex.enabled
          && toolCapabilities.codex,
        asyncImage: options.atomicImageReply ? false : options.allowAsyncImage ?? true,
        imageTools: options.allowImageTools ?? true,
        systemConfig: systemConfigLifecycle?.toolPort, cron: this.scheduledTasks.toolPort(incoming, isAdmin, options.promptOverride),
        director: options.directorAccess === "none" ? undefined : this.director.toolPort(),
        ...(options.promptOverride === undefined ? { air: this.air.toolPort(incoming, [...messages64, { role: "user", content: prompt }]) } : {}),
        ...(options.promptOverride === undefined ? { workingMemory: this.workingMemory.toolPort(incoming) } : {}),
        skills: runtimeAgentExtensions?.skills,
        mcp: runtimeAgentExtensions?.mcp,
        logContext
      });
      if (turn.kind === "deferred") usedToolNames.add(turn.toolCall.name);
      const turnToolNames = finalizeToolNames();
      if (options.promptOverride === undefined) {
        this.workingMemory.recordToolDecision(incoming, turnToolNames);
      }
      if (turn.kind !== "completed") systemConfigLifecycle?.discard();
      if (options.signal?.aborted || (options.isCurrent && !options.isCurrent())) {
        systemConfigLifecycle?.discard();
        return sent;
      }
      modelContextMemory.commit();
      if (turn.kind === "no_reply" || (options.atomicImageReply && turn.kind === "completed" && generatedImages.length === 0)) {
        this.discardAssistantRequest(incoming, logRunId);
        if (options.delivery) options.delivery.terminalStatus = "no_reply";
        if (!options.atomicImageReply && this.config.bot.pokeOnNoReply && gateway.poke) {
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
          ...(options.delivery?.mentionUserIds?.length ? { mentionUserIds: [...options.delivery.mentionUserIds] } : {}),
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
            options.delivery?.replyQuote, preparedAcknowledgement.contentSegments, options.delivery?.mentionUserIds
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
        toolNames: turnToolNames, singleMessage: options.atomicImageReply
      };
      sent = await (turn.voice ? sendRuntimeVoiceFinalReply(this, { ...finalReply, voice: turn.voice, textAlreadyDelivered: turn.textAlreadyDelivered })
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
      if (options.atomicImageReply) {
        if (requestStarted) this.discardAssistantRequest(incoming, logRunId); if (options.delivery) options.delivery.terminalStatus = "no_reply";
        return sent;
      }
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
        systemTimeZone: systemModelTimeZone(),
        conversation: {
          id: record?.id ?? conversationRecordId(incoming),
          scope: incoming.scope,
          title: record?.title ?? String(incoming.groupId),
          groupId: incoming.groupId,
          windowHours: 6,
          windowStart: formatModelTimestamp(new Date(now.getTime() - GROUP_CHAT_SUMMARY_WINDOW_MS)),
          windowEnd: formatModelTimestamp(now),
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
    if (isSuccessfulGeneratedImageResult(result)) {
      recordGeneratedImageHistory(this.config, result.image, {
        prompt: readStringField(result, "prompt"),
        size: readStringField(result, "size"),
        resolution: readStringField(result, "resolution")
      });
    }
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

function recordGeneratedImageHistory(config: SunaRuntime["config"], image: ImageResult, metadata?: GeneratedImageMetadata) {
  const url = String(image.url ?? "").trim();
  if (!url && !image.filePath) return;
  const id = (url.split(/[\\/]/).pop() || image.filePath?.split(/[\\/]/).pop() || "generated-image").trim();
  applicationDataStore(config).appendImageHistory({
    id,
    url,
    ...(image.filePath ? { filePath: image.filePath } : {}),
    ...(metadata?.prompt ? { prompt: metadata.prompt } : {}),
    ...(metadata?.size ? { size: metadata.size } : {}),
    ...(metadata?.resolution === "1K" || metadata?.resolution === "2K" || metadata?.resolution === "4K"
      ? { resolution: metadata.resolution }
      : {}),
    createdAt: new Date().toISOString()
  });
}

function isSuccessfulGeneratedImageResult(value: unknown): value is { ok: true; image: ImageResult } & Record<string, unknown> {
  const result = value as { ok?: unknown; image?: ImageResult };
  return result?.ok === true && Boolean(result.image?.url || result.image?.filePath);
}

function readStringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}
