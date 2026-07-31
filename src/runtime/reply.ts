import { nanoid } from "nanoid";
import {
  inboundImageUrls,
  type MessagingPort
} from "../../packages/contracts/messaging/messages.js";
import { AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } from "../../packages/contracts/model/modelGateway.js";
import { noReplyPokeEnvelope } from "../../packages/contracts/session/runtimeMessages.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { readCallbackInput } from "../../services/agent/callbackInput.js";
import { formatModelTimestamp, systemModelTimeZone } from "../../services/agent/modelTime.js";
import {
  buildCommonPromptVariables,
  buildConversationPromptVariables
} from "../../services/agent/persona.js";
import { senderDisplayName } from "../../services/conversations/senderName.js";
import { DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE } from "../../services/director/public.js";
import { searchKnowledge } from "../../services/knowledge/public.js";
import { serializeUserGroupOrchestratorResult } from "../../services/orchestration/userGroupOrchestratorResult.js";
import { DISPATCH_MESSAGE_MAX_CHARS } from "../../services/tools/deferredDispatch.js";
import {
  codexControlAvailable,
  codexTurnAvailable
} from "../../services/tools/codexControlPolicy.js";
import type { AddWorkMemoryToolPort } from "../../services/tools/public.js";
import type { SunaRuntime } from "../runtime.js";
import { getAgentPrivatePath } from "../config.js";
import {
  type AssistantMessageOrigin,
  type ImageResult,
  type ParsedIncomingMessage
} from "../types.js";
import {
  applyRuntimeAgentExtensionPrompt,
  collectRuntimeAgentExtensionBatchTexts
} from "./agentExtensions.js";
import {
  buildMemoryPromptVariables,
  buildUserPrompt,
  collectGroupChatSummaryMessages,
  isAdminUserId
} from "./conversationMemoryHelpers.js";
import { emojiPromptVariables, prepareRuntimeEmojiText } from "./emojiReply.js";
import { currentPromptInputMessage } from "./promptRequestHelpers.js";
import { recordGeneratedImageHistory } from "./generatedImageHistory.js";
import { errorMessage, isAbortError, sanitizeErrorDetail } from "./infrastructure.js";
import { conversationRecordId, queueIncomingSnapshot } from "./messagingAttachmentHelpers.js";
import {
  snapshotDeferredImageTask
} from "./deferredImageReferences.js";
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
import { ReplyDebounceContext, type ReplyDebounceContextOptions } from "./replyDebounceContext.js";
import { runtime_replyToToolCompletion } from "./replyDebounceDispatch.js";
import {
  appendReplyActionLog,
  appendReplySoftErrors,
  isolateReplyModule
} from "./replyModuleIsolation.js";
import { prepareReplyAgentExtensions } from "./replyAgentExtensionIsolation.js";
import { prepareReplyMemoryContext } from "./replyMemoryIsolation.js";
import { replyProvider } from "./replyProvider.js";
import {
  GROUP_CHAT_SUMMARY_COMMAND,
  GROUP_CHAT_SUMMARY_WINDOW_MS,
  MAX_CURRENT_CONTEXT_IMAGES,
  MESSAGE_32_CONTEXT_TOKEN_BUDGET,
  type DirectorReplyAccess,
  type DeferredCodexTurn,
  type ReplyDelivery
} from "./runtimeContracts.js";
import * as systemConfigReply from "./systemConfigReply.js";
import { sendRuntimeVoiceFinalReply, startRuntimeDeferredVoiceSynthesis } from "./voiceReply.js";
import { providerWorkbenchFilesForIncoming } from "./workbenchFiles.js";
import { providerChatMediaForIncoming } from "./chatMedia.js";
import { conversationCapabilityForIncoming } from "./conversationCapability.js";
import { snapshotDeferredCodexTask } from "./deferredCodexArtifacts.js";
export { runtime_processDeferredToolJob } from "./deferredImageJobs.js";
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
      memoryDecisionKey?: string;
    } = {}
  ) {
    const provider = replyProvider(this);
    const admin = this.adminIdentity();
    const isAdmin = isAdminUserId(incoming.userId, admin);
    const capabilityContext = conversationCapabilityForIncoming(
      incoming,
      this.config.persona.defaultAgentId,
      isAdmin,
      this.configEpoch
    );
    const codexControl = !options.atomicImageReply && codexControlAvailable(
      { isAdmin, scope: incoming.scope, promptOverride: options.promptOverride });
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
    let workingMemoryTurn: AddWorkMemoryToolPort | undefined;
    let workingMemoryDecisionAudited = false;
    const replySoftErrors: string[] = [];
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
      try {
        this.recordAssistantTurnTools(incoming, logRunId, toolNames);
      } catch (error) {
        console.error("[runtime] assistant tool trace unavailable", { error });
      }
      return toolNames;
    };
    const auditWorkingMemoryDecision = async (toolNames: readonly string[]) => {
      if (
        workingMemoryDecisionAudited
        || !workingMemoryTurn
        || workingMemoryTurn.decisionResolved?.() === true
      ) return;
      workingMemoryDecisionAudited = true;
      await isolateReplyModule(
        "memory.tool_decision",
        async () => this.workingMemory.recordToolDecision(incoming, toolNames),
        () => undefined,
        { signal: options.signal }
      );
    };
    try {
      const beforeContext = await this.hooks.run("before_context", {
        channel: channelKey,
        text: options.promptOverride ?? incoming.text,
        context: { scope: incoming.scope, userId: incoming.userId, groupId: incoming.groupId, isAdmin }
      });
      const {
        modelContextMemory,
        longTermMemoryMatches,
        workingMemoryMatches,
        userProfileMemoryMatches,
        currentUserProfileMemoryMatches,
        memoryMatches,
        exactUserProfile,
        queries: memoryQueries
      } = await prepareReplyMemoryContext(
        this.config,
        logRunId,
        incoming,
        beforeContext.text,
        admin,
        options.signal
      );
      await appendReplyActionLog({
        category: "runtime.action",
        action: "memory.recall.before_reply",
        request: {
          longTermQuery: memoryQueries.longTerm,
          workingQuery: memoryQueries.working,
          userProfileQuery: memoryQueries.userProfile
        },
        response: {
          workingCount: workingMemoryMatches.length,
          longTermCount: longTermMemoryMatches.length,
          userProfileCount: userProfileMemoryMatches.length,
          exactUserProfile,
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
      const attachmentContext = await isolateReplyModule(
        "attachments",
        () => debounceContext.buildAttachmentContext(afterContext.text),
        () => ({ text: "", localImagePaths: [], attachments: [] }),
        { signal: options.signal }
      );
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
      const message32 = this.buildRecentContextMessages(
        incoming,
        debounceContext.historyCaptureSequence,
        32,
        MESSAGE_32_CONTEXT_TOKEN_BUDGET
      );
      const messages64 = this.buildRecentContextMessages(incoming, debounceContext.historyCaptureSequence, 64);
      const conversationMessages = this.buildRecentContextMessages(incoming, debounceContext.historyCaptureSequence), markerId = nanoid();
      const currentInputMarker = incoming.scope === "private" ? undefined : { start: `\uE000sunabot-current-input:${markerId}:start\uE001`, end: `\uE000sunabot-current-input:${markerId}:end\uE001` };
      const voiceSnapshot = await this.voiceSnapshot();
      const directorContext = options.directorAccess === "none"
        ? ""
        : await isolateReplyModule(
          "director",
          () => this.director.promptContext(),
          () => "",
          { signal: options.signal }
        );
      let promptRequest = await this.renderPromptRequest(promptId, {
        ...buildCommonPromptVariables(this.config, { scope: incoming.scope,
          userName: senderDisplayName(incoming.sender) || String(incoming.userId) }),
        ...buildConversationPromptVariables(this.config),
        ...emojiPromptVariables(this.config),
        ...voiceSnapshot.variables,
        ...buildMemoryPromptVariables({ working: workingMemoryMatches,
          longTerm: longTermMemoryMatches, userProfile: currentUserProfileMemoryMatches }),
        "message_32": message32,
        "messages_64": messages64,
        "conversation.messages": conversationMessages,
        [DIRECTOR_CONVERSATION_SCHEDULE_VARIABLE]: directorContext,
        ...(incoming.scope === "private" ? {} : { "conversation.group.orchestrator_result": serializeUserGroupOrchestratorResult(options.orchestratorResult) }),
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
      const extensionPreparation = options.promptOverride === undefined
        ? await prepareReplyAgentExtensions(this.agentExtensions, {
          agentId: this.config.persona.defaultAgentId,
          conversationId: conversationRecordId(incoming),
          accountId: incoming.accountId ?? "primary",
          transport: incoming.transport === "web" ? "web" : "onebot",
          userId: incoming.userId,
          confirmationTexts: extensionBatchTexts,
          canApproveMcpTools: isAdmin,
          signal: options.signal
        }, extensionBatchTexts)
        : { prepared: undefined, softErrors: [] };
      const runtimeAgentExtensions = extensionPreparation.prepared;
      replySoftErrors.push(...extensionPreparation.softErrors);
      promptRequest = applyRuntimeAgentExtensionPrompt(promptRequest, runtimeAgentExtensions);
      systemConfigLifecycle = systemConfigReply.createSystemConfigReplyLifecycle(
        this, incoming, isAdmin, options.promptOverride, promptRequest
      );
      const currentUserMessage = currentPromptInputMessage(promptRequest, currentInputMarker);
      if (currentUserMessage) {
        currentUserMessage.imageUrls = debounceContext.currentImageUrls().slice(0, MAX_CURRENT_CONTEXT_IMAGES);
        currentUserMessage.imageAltTexts = debounceContext.currentImageAltTexts().slice(0, MAX_CURRENT_CONTEXT_IMAGES);
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
      await appendReplyActionLog({
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
      const toolCapabilities = await isolateReplyModule(
        "tool_capabilities",
        () => this.resolveToolCapabilities(null),
        () => ({ codex: false, workspaceBash: false }),
        { signal: options.signal }
      );
      const [nativeBash, dockerBash] = await Promise.all([
        capabilityContext
          ? this.resolveProviderBashHandle(incoming, options.promptOverride, "native", capabilityContext)
          : Promise.resolve(undefined),
        capabilityContext
          ? this.resolveProviderBashHandle(incoming, options.promptOverride, "docker", capabilityContext)
          : Promise.resolve(undefined)
      ]);
      const chatMedia = capabilityContext
        ? providerChatMediaForIncoming(
          this.config,
          incoming,
          options.promptOverride,
          this.attachmentService.cache,
          () => (
            this.configEpoch === capabilityContext.configEpoch
            && (!options.isCurrent || options.isCurrent())
            && !options.signal?.aborted
          ),
          capabilityContext
        )
        : undefined;
      workingMemoryTurn = options.promptOverride === undefined
        ? this.workingMemory.toolPort(incoming, options.memoryDecisionKey)
        : undefined;
      const turn = await this.completePromptTurn(provider, promptRequest, {
        signal: options.signal,
        modelRequestMaxRetries: this.config.normalReply.maxRetries,
        ...(options.messageOrigin === "async_tool_callback" ? { modelRequestAttemptTimeoutMs: AUXILIARY_MODEL_RESPONSE_TIMEOUT_MS } : {}),
        allowNoReply: true,
        workbenchFiles: capabilityContext
          ? providerWorkbenchFilesForIncoming(
            this.config,
            incoming,
            options.promptOverride,
            capabilityContext
          )
          : undefined,
        chatMedia,
        bash: {
          ...(nativeBash ? { native: nativeBash } : {}),
          ...(dockerBash ? { docker: dockerBash } : {})
        },
        conversationAssets: options.atomicImageReply || !capabilityContext
          ? undefined
          : this.conversationAssetProviderOptions(
            incoming,
            gateway,
            logRunId,
            options.isCurrent,
            options.delivery,
            capabilityContext
          ),
        voice: options.atomicImageReply ? undefined : this.voiceProviderCapability(voiceSnapshot.profile, incoming, gateway, options.delivery),
        bot: this.config.bot,
        disabledTools: this.conversationRecords.get(conversationRecordId(incoming))?.disabledTools,
        generateImage: (prompt, size, quality, referenceImageUrls, childLogContext) => provider.generateImage(
          prompt,
          size,
          quality,
          referenceImageUrls,
          childLogContext ?? logContext, options.signal
        ),
        resolveWorkbenchImagePaths: capabilityContext
          ? (paths) => this.resolveWorkbenchImageReferences(
            incoming,
            paths,
            () => !options.signal?.aborted && (!options.isCurrent || options.isCurrent()),
            capabilityContext
          )
          : undefined,
        onAssistantText: options.atomicImageReply ? undefined : async (text, source = "text") => {
          if (options.isCurrent && !options.isCurrent()) return;
          const quoteReply = assistantTextCount === 0;
          assistantTextCount += 1;
          const record = await this.sendAssistantReply(
            channelKey,
            incoming,
            gateway,
            appendReplySoftErrors(text, replySoftErrors),
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
          try {
            recordGeneratedImageHistory(this.config, image, metadata);
          } catch (error) {
            console.error("[runtime] generated image history unavailable", { error });
          }
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
            resolveWorkbenchImagePaths: capabilityContext
              ? (paths) => this.resolveWorkbenchImageReferences(
                incoming,
                paths,
                () => !options.signal?.aborted && (!options.isCurrent || options.isCurrent()),
                capabilityContext
              )
              : undefined,
            logContext, signal: options.signal
          })
        },
        asyncCodex: codexTurnAvailable({
          enabled: this.config.bot.tools.codex.enabled,
          control: codexControl,
          requiresWorker: typeof chatMedia?.freezeCodexInputs === "function",
          workerAvailable: isAdmin
            && options.promptOverride === undefined
            && !options.atomicImageReply
            && (options.allowAsyncCodex ?? true)
            && Boolean(capabilityContext)
            && toolCapabilities.codex
        }),
        codexControl,
        asyncImage: options.atomicImageReply ? false : options.allowAsyncImage ?? true,
        imageTools: options.allowImageTools ?? true,
        systemConfig: systemConfigLifecycle?.toolPort, cron: this.scheduledTasks.toolPort(incoming, isAdmin, options.promptOverride),
        director: options.directorAccess === "none" ? undefined : this.director.toolPort(),
        ...(options.promptOverride === undefined ? { air: this.air.toolPort(incoming, [...messages64, { role: "user", content: prompt }]) } : {}),
        ...(workingMemoryTurn ? { workingMemory: workingMemoryTurn } : {}),
        skills: runtimeAgentExtensions?.skills,
        mcp: runtimeAgentExtensions?.mcp,
        logContext
      });
      if (turn.kind === "deferred") usedToolNames.add(turn.toolCall.name);
      const turnToolNames = finalizeToolNames();
      await auditWorkingMemoryDecision(turnToolNames);
      if (options.signal?.aborted || (options.isCurrent && !options.isCurrent())) {
        systemConfigLifecycle?.discard();
        return sent;
      }
      await isolateReplyModule(
        "memory.recall_commit",
        async () => modelContextMemory.commit(),
        () => undefined,
        { signal: options.signal }
      );
      if (turn.kind !== "completed") {
        await systemConfigLifecycle?.commitWithoutConfirmation();
      }
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
              await appendReplyActionLog({
                category: "runtime.action",
                action: "reply.no_reply.poke.failed",
                request: target,
                response: { error: sanitizeErrorDetail(errorMessage(error)) },
                metadata: logContext
              });
            }
          }
        }
        await appendReplyActionLog({
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
        const acknowledgementWithErrors = appendReplySoftErrors(acknowledgement, replySoftErrors);
        const preparedAcknowledgement = await isolateReplyModule(
          "tone.dispatch_message",
          () => prepareRuntimeEmojiText(acknowledgementWithErrors, this.config,
            (value) => this.rewriteToneText(value, { incoming, signal: options.signal, logContext })),
          () => prepareRuntimeEmojiText(
            appendReplySoftErrors(acknowledgementWithErrors, ["表达优化暂不可用"]),
            this.config,
            async (value) => value
          ),
          { signal: options.signal }
        );
        if (preparedAcknowledgement.text.length > DISPATCH_MESSAGE_MAX_CHARS) {
          throw new Error(`Tone 处理后的 dispatch_message 不能超过 ${DISPATCH_MESSAGE_MAX_CHARS} 个字符。`);
        }
        const deferredCodex = await snapshotDeferredCodexTask({
          toolCall: turn.toolCall,
          capability: capabilityContext,
          chatMedia,
          jobRoot: getAgentPrivatePath(
            this.config,
            WORKSPACE_LAYOUT.codexJobs,
            "runtime",
            "codex-jobs"
          ),
          isCurrent: () => (
            (!capabilityContext || this.configEpoch === capabilityContext.configEpoch)
            && !options.signal?.aborted
            && (!options.isCurrent || options.isCurrent())
          )
        });
        const deferredImages = await snapshotDeferredImageTask(this, incoming, deferredCodex.toolCall, generateImgReferenceContext,
          () => !options.signal?.aborted && (!options.isCurrent || options.isCurrent()));
        const originalRequest = {
          incoming: deferredImages.incoming,
          captureSequence: options.captureSequence,
          contextThroughSequence: options.contextThroughSequence,
          imageReferences: deferredImages.imageReferences,
          ...(deferredImages.workbenchImagesByPath ? { workbenchImagesByPath: deferredImages.workbenchImagesByPath } : {}),
          replyGate: this.replyGates.capture(incoming.scope, conversationRecordId(incoming)),
          ...(options.delivery?.replyQuote ? { replyQuote: options.delivery.replyQuote } : {}),
          ...(options.delivery?.mentionUserIds?.length ? { mentionUserIds: [...options.delivery.mentionUserIds] } : {}),
          ...(options.orchestratorResult ? { orchestratorResult: options.orchestratorResult } : {})
        };
        options.onDeferred?.({
          ...(deferredCodex.jobId ? { jobId: deferredCodex.jobId } : {}),
          deferred: {
            ...turn,
            toolCall: deferredImages.toolCall
          },
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
        channelKey, incoming, gateway, text: appendReplySoftErrors(turn.text, replySoftErrors), isAdmin,
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
      await auditWorkingMemoryDecision(failedToolNames);
      const failure = options.signal?.reason ?? error;
      const aborted = options.signal?.aborted || isAbortError(error);
      await appendReplyActionLog({
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
      const provider = replyProvider(this);
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
