import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  AppConfig,
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
import { isReplySenderAllowed } from "../../services/messaging/replySenderPolicy.js";
import { getDefaultProvider, getRootDir, getWorkspacePath, resolveProjectPath } from "../config.js";
import {
  assistantReplyEnvelope,
  decodeAssistantReply,
  decodeIncomingReply,
  decodeToolCompletion,
  incomingReplyEnvelope,
  type AssistantReplyOutboxEnvelope,
  type AssistantReplyOutboxPayload,
  type AsyncToolCompletionPayload,
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
import {
  OpenAIProvider,
  type ProviderBashOptions,
  type ProviderCompleteOptions,
  type ProviderDeferredTurn
} from "../../adapters/model/openaiProvider.js";
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
import {
  resolveGenerateImgReferences,
  type GenerateImgReferenceContext
} from "../../services/tools/generateImgTool.js";
import { cleanupPersistedCodexProcess, CodexToolRunner } from "../../adapters/codex/codexTool.js";
import { isTrustedQqFakeIp } from "../../adapters/onebot/qqMedia.js";
import type { CodexRunner } from "../../packages/contracts/tools/codex.js";
import {
  OutboxDisconnectedError,
  SessionCoordinator,
  type SessionHandleResult
} from "../../services/sessions/sessionCoordinator.js";
import { SessionStore, type OutboxRecord, type SessionEventRecord } from "../../services/sessions/sessionStore.js";
import { TOOL_CALL_TIMEOUT_MS } from "../../services/tools/tools.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent as defaultFinalPromptContent } from "../../services/agent/promptDefaults.js";
import {
  parseFinalPromptTemplate,
  renderFinalPromptTemplate,
  type PromptVariableValue,
  type RenderedPromptRequest
} from "../../services/agent/promptSystem.js";
import { buildConversationPromptVariables } from "../../services/agent/persona.js";
import { DEFAULT_CONTEXT_MESSAGE_LIMIT, MAX_STORED_CONVERSATION_MESSAGES, GROUP_CHAT_SUMMARY_WINDOW_MS, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES, MAX_CURRENT_CONTEXT_IMAGES, MAX_HISTORY_CONTEXT_IMAGES, HYDRATE_MESSAGE_WINDOW_MS, ACTIVE_CONVERSATION_WINDOW_MS, DIRECT_REPLY_TIMEOUT_MS, AMBIENT_ORCHESTRATOR_TIMEOUT_MS, ORCHESTRATOR_MAX_RETRIES, PREPARE_TIMEOUT_MS, RECENT_CONTEXT_TOKEN_BUDGET, DEDUPE_TTL_MS, MAX_DEDUPE_KEYS, DEFAULT_ADMIN_NAME, GROUP_CHAT_SUMMARY_COMMAND, CONVERSATION_REPLY_PROMPT_FILE, SELFIE_PROMPT_FILE, GROUP_CHAT_SUMMARY_PROMPT_FILE, ADMIN_PERSONA_FILES, ADMIN_RUNTIME_PROMPT_DEFAULTS, BatchUserInfo, WorkingMemoryMergeOutput, WorkingMemoryMergeContext, personaFileNameForAdminId, AdminIdentity, ConversationReplyUpdateInput, RuntimeCommandContext, ReplyDeliveryDraft, ReplyDelivery, DeferredCodexTurn, AmbientReplyJob, AmbientReplyState, AmbientIdleTimer, RuntimeConfigSnapshot, RuntimePromptSnapshot, SunaRuntimeOptions } from "./runtimeContracts.js";
import { isMemoryEntryRelatedToUsers } from "./conversationMemoryHelpers.js";
import { isSelfieImageFile, normalizeSelfiePrompt, normalizeSelfieQuality, normalizeSelfieReferenceImageUrls, normalizeSelfieResolution, normalizeSelfieSize, selfieMimeType, shuffle } from "./selfieHelpers.js";
import { conversationRecordId, uniqueStrings } from "./messagingAttachmentHelpers.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

export async function runtime_readRelevantUserProfiles(this: RuntimeHost, participants: BatchUserInfo[]) {
    const userIds = new Set(participants.map((item) => item.userId));
    const entries = await readMemorySourceEntries(this.config, "user_profile");
    return entries
      .filter((entry) => isMemoryEntryRelatedToUsers(entry, userIds))
      .slice(-40)
      .map((entry) => ({
        id: entry.id,
        userId: entry.userId,
        userIds: entry.userIds,
        userName: entry.userName,
        addressName: entry.addressName,
        fact: entry.text,
        occurredAt: entry.occurredAt,
        occurredEndAt: entry.occurredEndAt,
        observedAt: entry.observedAt,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        time: entry.time || ""
      }));
  }
export async function runtime_runSelfie(this: RuntimeHost,
    input: SelfieInput,
    provider: OpenAIProvider,
    options: {
      chatReferenceImageUrls?: string[];
      imageReferences?: GenerateImgReferenceContext;
      logContext?: ProviderLogContext;
    } = {}
  ): Promise<SelfieRunResult> {
    if (this.config.bot.tools.generateImg.provider === "custom") {
      return { ok: false, error: "自定义生图暂不支持。" };
    }

    const prompt = normalizeSelfiePrompt(input.prompt);
    if (!prompt) {
      return { ok: false, error: "Selfie prompt is empty." };
    }

    const workspaceReferenceImageUrls = await this.loadSelfieReferenceImages();
    if (!workspaceReferenceImageUrls.length) {
      return { ok: false, error: "Selfie reference images are not configured." };
    }

    const defaultChatReferenceImageUrls = normalizeSelfieReferenceImageUrls(options.chatReferenceImageUrls);
    const availableChatReferenceSlots = Math.max(0, MAX_SELFIE_REFERENCE_IMAGES - workspaceReferenceImageUrls.length);
    const chatReferenceImageUrls = resolveGenerateImgReferences(input, {
      referenceImageUrls: defaultChatReferenceImageUrls,
      imageReferences: options.imageReferences
    }).referenceImageUrls.slice(0, availableChatReferenceSlots);
    const referenceImageUrls = uniqueStrings([
      ...workspaceReferenceImageUrls,
      ...chatReferenceImageUrls
    ]).slice(0, MAX_SELFIE_REFERENCE_IMAGES);
    const resolution = normalizeSelfieResolution(input.resolution, this.config.bot.tools.generateImg.resolution);
    const size = normalizeSelfieSize(input.size, this.config.bot.tools.generateImg.size, resolution);
    const quality = normalizeSelfieQuality(input.quality, this.config.bot.tools.generateImg.quality);
    const rewrittenPrompt = await this.rewriteSelfiePrompt(provider, prompt, size, {
      workspaceReferenceImageCount: workspaceReferenceImageUrls.length,
      chatReferenceImageCount: chatReferenceImageUrls.length
    }, options.logContext);
    const image = await provider.generateImage(rewrittenPrompt, size, quality, referenceImageUrls, options.logContext);
    return {
      ok: true,
      provider: "codex-image-gen",
      prompt,
      rewrittenPrompt,
      size,
      resolution,
      quality,
      referenceImageCount: referenceImageUrls.length,
      workspaceReferenceImageCount: workspaceReferenceImageUrls.length,
      chatReferenceImageCount: chatReferenceImageUrls.length,
      image
    };
  }
export async function runtime_rewriteSelfiePrompt(this: RuntimeHost,
    provider: OpenAIProvider,
    prompt: string,
    size: string,
    references: { workspaceReferenceImageCount: number; chatReferenceImageCount: number },
    logContext?: ProviderLogContext
  ) {
    const payload = {
          request: prompt,
          size,
          references: {
            workspaceSelfieCount: references.workspaceReferenceImageCount,
            chatImageCount: references.chatReferenceImageCount,
            instruction: references.chatReferenceImageCount
              ? "聊天参考图会和普拉娜自拍参考图一起送入图像生成。合照时保留聊天参考图中的用户；拿东西、穿衣服或使用物品时保留聊天参考图中的物品。"
              : "本次只有普拉娜自拍参考图。"
          },
          persona: {
            name: this.persona?.name ?? "普拉娜"
          }
        };
    const promptRequest = await this.renderPromptRequest("image.selfie-rewrite", {
      "selfie.payload": payload
    });
    const rewritten = await this.completePrompt(provider, promptRequest, {
      logContext: { ...logContext, promptFamily: "image.selfie-rewrite" }
    });
    return normalizeSelfiePrompt(rewritten) || prompt;
  }
export function runtime_collectSelfieChatReferenceImages(this: RuntimeHost, incoming: ParsedIncomingMessage, captureSequence?: number) {
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    const currentMessageId = incoming.messageId == null ? "" : String(incoming.messageId);
    const recentImages = record?.messages
      .filter((message) => message.role === "user")
      .filter((message) => !currentMessageId || message.id !== currentMessageId)
      .filter((message) => captureSequence == null || Number(message.sequence ?? 0) < captureSequence)
      .slice(-this.contextMessageLimit())
      .reverse()
      .flatMap((message) => [
        ...(message.imageUrls ?? []),
        ...(message.quoteReferences ?? []).flatMap((quote) => quote.imageUrls ?? [])
      ]) ?? [];
    return uniqueStrings([
      ...inboundImageUrls(incoming),
      ...recentImages
    ]).slice(0, MAX_SELFIE_REFERENCE_IMAGES);
  }
export async function runtime_loadSelfieReferenceImages(this: RuntimeHost) {
    const workspace = resolveProjectPath(this.config.persona.agentWorkspace);
    if (!workspace) return [];

    const selfieDir = path.join(workspace, "selfie");
    let fileNames: string[] = [];
    try {
      fileNames = await fsp.readdir(selfieDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const imagePaths = shuffle(fileNames
      .filter((fileName) => isSelfieImageFile(fileName))
      .map((fileName) => path.join(selfieDir, fileName)))
      .slice(0, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES);
    const images: string[] = [];
    for (const filePath of imagePaths) {
      const bytes = await fsp.readFile(filePath);
      images.push(`data:${selfieMimeType(filePath)};base64,${bytes.toString("base64")}`);
    }
    return images;
  }

export class RuntimeSelfie {
  constructor(private readonly host: RuntimeHost) {}
  readRelevantUserProfiles(...args: Parameters<typeof runtime_readRelevantUserProfiles>) { return runtime_readRelevantUserProfiles.call(this.host, ...args); }
  runSelfie(...args: Parameters<typeof runtime_runSelfie>) { return runtime_runSelfie.call(this.host, ...args); }
  rewriteSelfiePrompt(...args: Parameters<typeof runtime_rewriteSelfiePrompt>) { return runtime_rewriteSelfiePrompt.call(this.host, ...args); }
  collectSelfieChatReferenceImages(...args: Parameters<typeof runtime_collectSelfieChatReferenceImages>) { return runtime_collectSelfieChatReferenceImages.call(this.host, ...args); }
  loadSelfieReferenceImages(...args: Parameters<typeof runtime_loadSelfieReferenceImages>) { return runtime_loadSelfieReferenceImages.call(this.host, ...args); }
}
