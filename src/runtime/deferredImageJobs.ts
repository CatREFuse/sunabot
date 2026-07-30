import { inboundImageUrls } from "../../packages/contracts/messaging/messages.js";
import type { ToolJobRecord } from "../../services/sessions/sessionStore.js";
import { GENERATE_IMG_TOOL_NAME, runGenerateImg } from "../../services/tools/generateImgTool.js";
import { SELFIE_TOOL_NAME } from "../../services/tools/selfieTool.js";
import type { SunaRuntime } from "../runtime.js";
import type { ImageResult } from "../types.js";
import { recordGeneratedImageHistory } from "./generatedImageHistory.js";
import { isRuntimeIncomingMessage } from "./infrastructure.js";
import { conversationRecordId } from "./messagingAttachmentHelpers.js";
import {
  deferredWorkbenchImageResolver,
  readGenerateImgReferenceContext
} from "./deferredImageReferences.js";
import { runtime_generateImgReferenceContext } from "./replyContext.js";
import { resolveReplyContextCaptureSequence } from "./replyDebounceContext.js";
import { replyProvider } from "./replyProvider.js";

type RuntimeHost = SunaRuntime;

export async function runtime_processDeferredToolJob(
  this: RuntimeHost,
  job: ToolJobRecord,
  signal: AbortSignal
) {
  if (signal.aborted) throw signal.reason ?? new Error("异步工具任务已取消。");
  const originalRequest = job.originalRequest as {
    incoming?: unknown;
    captureSequence?: unknown;
    contextThroughSequence?: unknown;
    imageReferences?: unknown;
    workbenchImagesByPath?: unknown;
  };
  const incoming = originalRequest.incoming;
  if (!isRuntimeIncomingMessage(incoming)) {
    return { status: "failed" as const, error: { message: "异步图片任务缺少原始请求。" } };
  }
  const provider = replyProvider(this);
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
    originalRequest.captureSequence,
    originalRequest.contextThroughSequence
  );
  const imageReferences = readGenerateImgReferenceContext(originalRequest.imageReferences) ??
    runtime_generateImgReferenceContext.call(this, incoming, captureSequence);
  const resolveWorkbenchImagePaths = deferredWorkbenchImageResolver(
    originalRequest.workbenchImagesByPath
  );
  const result = job.toolName === GENERATE_IMG_TOOL_NAME
    ? await runGenerateImg(input, this.config.bot, (prompt, size, quality, referenceImageUrls, childLogContext) =>
        provider.generateImage(prompt, size, quality, referenceImageUrls, childLogContext ?? logContext), {
        referenceImageUrls: inboundImageUrls(incoming),
        imageReferences,
        resolveWorkbenchImagePaths,
        logContext
      })
    : job.toolName === SELFIE_TOOL_NAME
      ? await this.runSelfie(input, provider, {
          chatReferenceImageUrls: this.collectSelfieChatReferenceImages(incoming, captureSequence),
          imageReferences,
          resolveWorkbenchImagePaths,
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

function isSuccessfulGeneratedImageResult(
  value: unknown
): value is { ok: true; image: ImageResult } & Record<string, unknown> {
  const result = value as { ok?: unknown; image?: ImageResult };
  return result?.ok === true && Boolean(result.image?.url || result.image?.filePath);
}

function readStringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}
