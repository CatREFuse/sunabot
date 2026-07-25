import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { AGENT_RESOURCE_LAYOUT } from "../../packages/platform/agentResourceLayout.js";
import {
  OpenAIProvider
} from "../../adapters/model/openaiProvider.js";
import {
  inboundImageUrls
} from "../../packages/contracts/messaging/messages.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";
import {
  MAX_SELFIE_REFERENCE_BYTES,
  MAX_SELFIE_STORED_REFERENCE_IMAGES,
  SelfieReferenceCatalogError,
  loadSelfieReferenceCatalog,
  readSelfieReferenceImageFile,
  readSelfieReferenceManifest
} from "../../services/media/selfieReferenceCatalog.js";
import {
  readMemorySourceEntries
} from "../../services/memory/memoryService.js";
import {
  resolveGenerateImgReferences,
  type GenerateImgReferenceContext
} from "../../services/tools/generateImgTool.js";
import type { SelfieInput, SelfieRunResult } from "../../services/tools/selfieTool.js";
import { resolveProjectPath } from "../config.js";
import {
  ParsedIncomingMessage
} from "../types.js";
import { isMemoryEntryRelatedToUsers, resolveRuntimePersonaName } from "./conversationMemoryHelpers.js";
import { conversationRecordId, uniqueStrings } from "./messagingAttachmentHelpers.js";
import { BatchUserInfo, MAX_SELFIE_REFERENCE_IMAGES, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES } from "./runtimeContracts.js";
import { isSelfieImageFile, normalizeSelfiePrompt, normalizeSelfieQuality, normalizeSelfieReferenceImageUrls, normalizeSelfieResolution, normalizeSelfieSize, selfieMimeType } from "./selfieHelpers.js";

import type { SunaRuntime } from "../runtime.js";
type RuntimeHost = SunaRuntime;

interface RuntimeSelfieReference {
  id: string;
  fileName: string;
  filePath: string;
  note: string;
  directoryDev: number;
  directoryIno: number;
}

interface RewrittenSelfiePrompt {
  prompt: string;
  selectedSelfieReferenceIds: string[];
}

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
        addressNames: entry.addressNames,
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

    const workspaceReferences = await loadRuntimeSelfieReferences(this);
    if (!workspaceReferences.length) {
      return { ok: false, error: "Selfie reference images are not configured." };
    }

    const defaultChatReferenceImageUrls = normalizeSelfieReferenceImageUrls(options.chatReferenceImageUrls);
    const chatReferenceImageUrls = resolveGenerateImgReferences(input, {
      referenceImageUrls: defaultChatReferenceImageUrls,
      imageReferences: options.imageReferences
    }).referenceImageUrls.slice(0, MAX_SELFIE_REFERENCE_IMAGES - MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES);
    const resolution = normalizeSelfieResolution(input.resolution, this.config.bot.tools.generateImg.resolution);
    const size = normalizeSelfieSize(input.size, this.config.bot.tools.generateImg.size, resolution);
    const quality = normalizeSelfieQuality(input.quality, this.config.bot.tools.generateImg.quality);
    const rewrittenPrompt = await this.rewriteSelfiePrompt(provider, prompt, size, {
      workspaceSelfies: workspaceReferences.map(({ id, note }) => ({ id, note })),
      chatReferenceImageCount: chatReferenceImageUrls.length
    }, options.logContext);
    const workspaceReferencesById = new Map(workspaceReferences.map((reference) => [reference.id, reference]));
    const workspaceReferenceImageUrls = await Promise.all(rewrittenPrompt.selectedSelfieReferenceIds.map((id) =>
      readRuntimeSelfieReference(workspaceReferencesById.get(id)!)
    ));
    const referenceImageUrls = [...workspaceReferenceImageUrls, ...chatReferenceImageUrls];
    const image = await provider.generateImage(rewrittenPrompt.prompt, size, quality, referenceImageUrls, options.logContext);
    return {
      ok: true,
      provider: "codex-image-gen",
      prompt,
      rewrittenPrompt: rewrittenPrompt.prompt,
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
    references: {
      workspaceSelfies: Array<{ id: string; note: string }>;
      chatReferenceImageCount: number;
    },
    logContext?: ProviderLogContext
  ): Promise<RewrittenSelfiePrompt> {
    const payload = {
          request: prompt,
          size,
          references: {
            workspaceSelfies: references.workspaceSelfies.map(({ id, note }) => ({ id, note })),
            workspaceSelectionLimit: MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES,
            chatImageCount: references.chatReferenceImageCount,
            instruction: references.chatReferenceImageCount
              ? "从 workspaceSelfies 中选择 1 至 3 张最合适的自拍素材。聊天参考图会始终作为实际最后一张追加在所选自拍素材之后，并占用一个预留的聊天参考容量，因此 workspace 最多选择 3 张、总输入最多 4 张；不要把它加入 selectedSelfieReferenceIds。"
              : "从 workspaceSelfies 中选择 1 至 3 张最合适的自拍素材。"
          },
          persona: {
            name: resolveRuntimePersonaName(this.persona?.name, this.config.persona.name)
          }
        };
    const promptRequest = await this.renderPromptRequest("image.selfie-rewrite", {
      "selfie.payload": payload
    });
    const rewritten = await this.completePrompt(provider, promptRequest, {
      logContext: { ...logContext, promptFamily: "image.selfie-rewrite" }
    });
    return parseRewrittenSelfiePrompt(rewritten, new Set(references.workspaceSelfies.map(({ id }) => id)));
  }
export function runtime_collectSelfieChatReferenceImages(
  this: RuntimeHost,
  incoming: ParsedIncomingMessage,
  captureSequence?: number,
  currentBatchFromSequence?: number
) {
    const record = this.conversationRecords.get(conversationRecordId(incoming));
    const currentMessageId = incoming.messageId == null ? "" : String(incoming.messageId);
    const recentImages = record?.messages
      .filter((message) => message.role === "user")
      .filter((message) => !currentMessageId || message.id !== currentMessageId)
      .filter((message) => captureSequence == null || Number(message.sequence ?? 0) < captureSequence)
      .filter((message) => (
        currentBatchFromSequence == null ||
        Number(message.sequence ?? 0) < currentBatchFromSequence ||
        incoming.scope === "private" ||
        message.userId === incoming.userId
      ))
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
    const references = await loadRuntimeSelfieReferences(this);
    return Promise.all(references
      .slice(0, MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES)
      .map(readRuntimeSelfieReference));
  }

async function loadRuntimeSelfieReferences(runtime: RuntimeHost): Promise<RuntimeSelfieReference[]> {
  const workspace = resolveProjectPath(runtime.config.persona.agentWorkspace);
  if (!workspace) return [];

  const selfieDir = path.join(workspace, AGENT_RESOURCE_LAYOUT.selfie);
  let selfieDirectoryStats;
  try {
    selfieDirectoryStats = await fsp.lstat(selfieDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (selfieDirectoryStats.isSymbolicLink() || !selfieDirectoryStats.isDirectory()) {
    throw new Error("Selfie reference directory must be a regular directory.");
  }
  const entries = await fsp.readdir(selfieDir, { encoding: "utf8", withFileTypes: true });

  const imageFiles: Array<{ fileName: string; filePath: string }> = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (!isSelfieImageFile(entry.name)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("Selfie reference images must be regular files.");
    }
    const filePath = path.join(selfieDir, entry.name);
    const stats = await fsp.lstat(filePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error("Selfie reference images must be regular files.");
    }
    if (stats.size <= 0) {
      throw new Error("Selfie reference image is empty.");
    }
    if (stats.size > MAX_SELFIE_REFERENCE_BYTES) {
      throw new Error("Selfie reference image exceeds the 8 MiB limit.");
    }
    imageFiles.push({ fileName: entry.name, filePath });
  }
  if (imageFiles.length > MAX_SELFIE_STORED_REFERENCE_IMAGES) {
    throw new SelfieReferenceCatalogError(
      "SELFIE_REFERENCE_LIMIT",
      `自拍参考图最多保留 ${MAX_SELFIE_STORED_REFERENCE_IMAGES} 张。`
    );
  }

  const manifest = await readSelfieReferenceManifest(selfieDir);
  const filePathByName = new Map(imageFiles.map(({ fileName, filePath }) => [fileName, filePath]));
  const manifestFileNames = manifest?.references.map(({ fileName }) => fileName) ?? [];
  if (
    manifest
    && manifest.references.length === imageFiles.length
    && new Set(manifestFileNames).size === manifestFileNames.length
    && manifest.references.every(({ fileName }) => isSelfieImageFile(fileName) && filePathByName.has(fileName))
  ) {
    return manifest.references.map((reference) => ({
      ...reference,
      filePath: filePathByName.get(reference.fileName)!,
      directoryDev: selfieDirectoryStats.dev,
      directoryIno: selfieDirectoryStats.ino
    }));
  }

  const identities: Array<{ id: string; fileName: string; filePath: string }> = [];
  for (const image of imageFiles) {
    const { bytes } = await readSelfieReferenceImageFile(image.filePath);
    if (!bytes.length) throw new Error("Selfie reference image is empty.");
    identities.push({
      ...image,
      id: crypto.createHash("sha256").update(bytes).digest("hex")
    });
  }

  const catalog = await loadSelfieReferenceCatalog(selfieDir, identities);
  const pathById = new Map(identities.map(({ id, filePath }) => [id, filePath]));
  return catalog.references.map((reference) => ({
    ...reference,
    filePath: pathById.get(reference.id)!,
    directoryDev: selfieDirectoryStats.dev,
    directoryIno: selfieDirectoryStats.ino
  }));
}

async function readRuntimeSelfieReference(reference: RuntimeSelfieReference) {
  await assertRuntimeSelfieDirectory(reference);
  const { bytes } = await readSelfieReferenceImageFile(reference.filePath);
  await assertRuntimeSelfieDirectory(reference);
  if (!bytes.length) throw new Error("Selfie reference image is empty.");
  const actualId = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actualId !== reference.id) {
    throw new Error("Selfie reference image changed during selection.");
  }
  return `data:${selfieMimeType(reference.fileName)};base64,${bytes.toString("base64")}`;
}

async function assertRuntimeSelfieDirectory(reference: RuntimeSelfieReference) {
  const stats = await fsp.lstat(path.dirname(reference.filePath));
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== reference.directoryDev
    || stats.ino !== reference.directoryIno
  ) {
    throw new Error("Selfie reference directory changed during selection.");
  }
}

function parseRewrittenSelfiePrompt(raw: string, knownIds: ReadonlySet<string>): RewrittenSelfiePrompt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Selfie prompt rewrite returned invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Selfie prompt rewrite returned an invalid result.");
  }
  const result = parsed as Record<string, unknown>;
  const keys = Object.keys(result);
  if (keys.length !== 2 || !keys.includes("prompt") || !keys.includes("selectedSelfieReferenceIds")) {
    throw new Error("Selfie prompt rewrite returned an invalid result.");
  }
  if (typeof result.prompt !== "string") {
    throw new Error("Selfie prompt rewrite returned an invalid prompt.");
  }
  const prompt = result.prompt.trim();
  if (!prompt || [...prompt].length > 4_000) {
    throw new Error("Selfie prompt rewrite returned an invalid prompt.");
  }
  if (!Array.isArray(result.selectedSelfieReferenceIds)
    || result.selectedSelfieReferenceIds.length < 1
    || result.selectedSelfieReferenceIds.length > MAX_SELFIE_WORKSPACE_REFERENCE_IMAGES) {
    throw new Error("Selfie prompt rewrite selected an invalid number of references.");
  }
  const selectedIds = result.selectedSelfieReferenceIds;
  if (!selectedIds.every((id): id is string => typeof id === "string" && knownIds.has(id))) {
    throw new Error("Selfie prompt rewrite selected an unknown reference.");
  }
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error("Selfie prompt rewrite selected duplicate references.");
  }
  return { prompt, selectedSelfieReferenceIds: selectedIds };
}

export class RuntimeSelfie {
  constructor(private readonly host: RuntimeHost) {}
  readRelevantUserProfiles(...args: Parameters<typeof runtime_readRelevantUserProfiles>) { return runtime_readRelevantUserProfiles.call(this.host, ...args); }
  runSelfie(...args: Parameters<typeof runtime_runSelfie>) { return runtime_runSelfie.call(this.host, ...args); }
  rewriteSelfiePrompt(...args: Parameters<typeof runtime_rewriteSelfiePrompt>) { return runtime_rewriteSelfiePrompt.call(this.host, ...args); }
  collectSelfieChatReferenceImages(...args: Parameters<typeof runtime_collectSelfieChatReferenceImages>) { return runtime_collectSelfieChatReferenceImages.call(this.host, ...args); }
  loadSelfieReferenceImages(...args: Parameters<typeof runtime_loadSelfieReferenceImages>) { return runtime_loadSelfieReferenceImages.call(this.host, ...args); }
}
