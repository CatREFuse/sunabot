import type { ImageQuality } from "../../../packages/contracts/admin/public.js";
import type { ImageResult } from "../../../packages/contracts/media/media.js";
import type { ProviderLogContext } from "../../../packages/contracts/model/modelGateway.js";
import {
  ImageGenerationHttpError,
  ImageGenerationTransportError,
  isImageGenerationCancellation,
  runImageGenerationWithRetry
} from "../imageGenerationRetry.js";
import type { ProviderAdapterContext } from "./contracts.js";
import { buildImageGenerationContent, countInputImages } from "./imageInput.js";
import { withLogContext } from "./logger.js";
import {
  parseResponsesSsePayload,
  summarizeResponsesPayload
} from "./streamDecoder.js";
import {
  codexBackendHeaders,
  normalizeCodexResponsesUrl
} from "./transport.js";
import { errorMessage, parseJson, uniqueStrings } from "./valueUtils.js";

export const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const IMAGE_GENERATION_INSTRUCTIONS = "Generate the requested image with the hosted image_generation tool. Return the generated image only.";

export async function generateProviderImage(
  context: ProviderAdapterContext,
  prompt: string,
  size: string,
  quality: ImageQuality,
  referenceImageUrls: string[] = [],
  logContext?: ProviderLogContext
): Promise<ImageResult> {
  if (context.provider.kind !== "openai-official" && context.provider.kind !== "codex-responses") {
    throw new Error("当前 Provider 不支持 Responses 图像生成；请使用 OpenAI 官方或 Codex 订阅。");
  }
  const imageModel = context.provider.imageModel?.trim() || DEFAULT_IMAGE_MODEL;
  const imageSize = normalizeImageSize(size);
  const content = await buildImageGenerationContent(prompt, referenceImageUrls);

  if (context.provider.kind === "codex-responses") {
    return generateCodexImage(context, content, imageModel, imageSize, quality, referenceImageUrls, logContext);
  }
  return generateOpenAIImage(context, content, imageModel, imageSize, quality, referenceImageUrls, logContext);
}

async function generateOpenAIImage(
  context: ProviderAdapterContext,
  content: Array<Record<string, unknown>>,
  imageModel: string,
  imageSize: string,
  quality: ImageQuality,
  referenceImageUrls: string[],
  logContext?: ProviderLogContext
) {
  const client = context.createResponsesClient({ maxRetries: 0 });
  const requestBody = {
    model: context.provider.model,
    instructions: IMAGE_GENERATION_INSTRUCTIONS,
    input: [
      {
        role: "user",
        content
      }
    ],
    tools: [
      {
        type: "image_generation",
        model: imageModel,
        size: imageSize,
        quality
      }
    ],
    store: false,
    max_output_tokens: Math.min(Number(context.provider.maxOutputTokens || 1200), 1200),
    reasoning: context.provider.reasoningEffort ? { effort: context.provider.reasoningEffort } : undefined
  };
  const metadata = withLogContext({
    imageModel,
    size: imageSize,
    quality,
    referenceImageUrls: uniqueStrings(referenceImageUrls).slice(0, 4),
    resolvedReferenceImageCount: countInputImages(content)
  }, logContext);
  const result = await runImageGenerationWithRetry(async (attemptContext) => {
    await context.logger.request("image.generate", requestBody, { ...metadata, ...attemptContext });
    return client.responses.create(requestBody as never);
  }, {
    sleep: context.options.imageRetrySleep,
    onAttemptFailure: (error, failureContext) => context.logger.imageAttemptFailure(
      "image.generate",
      error,
      failureContext,
      metadata
    )
  });
  const finalMetadata = {
    ...metadata,
    attempt: result.attempt,
    maxAttempts: result.maxAttempts
  };
  try {
    const image = context.imageWriter.write(result.value, imageModel, imageSize);
    await context.logger.response("image.generate", {
      ok: true,
      summary: summarizeResponsesPayload(result.value, ""),
      image
    }, finalMetadata);
    return image;
  } catch (error) {
    await context.logger.response("image.generate", {
      ok: false,
      error: errorMessage(error),
      summary: summarizeResponsesPayload(result.value, ""),
      willRetry: false,
      retryDelayMs: 0
    }, finalMetadata);
    throw error;
  }
}

async function generateCodexImage(
  context: ProviderAdapterContext,
  content: Array<Record<string, unknown>>,
  imageModel: string,
  size: string,
  quality: ImageQuality,
  referenceImageUrls: string[],
  logContext?: ProviderLogContext
) {
  const apiKey = await context.getApiKeyAsync();
  if (!apiKey) throw new Error("Codex 未登录。请先运行 codex login，或设置 CODEX_ACCESS_TOKEN。");

  const requestBody = {
    model: context.provider.model,
    input: [
      {
        role: "user",
        content
      }
    ],
    instructions: IMAGE_GENERATION_INSTRUCTIONS,
    tools: [
      {
        type: "image_generation",
        model: imageModel,
        size,
        quality
      }
    ],
    store: false,
    stream: true,
    reasoning: context.provider.reasoningEffort
      ? { effort: context.provider.reasoningEffort, summary: "auto" }
      : undefined,
    include: ["reasoning.encrypted_content"]
  };
  const metadata = withLogContext({
    imageModel,
    size,
    quality,
    referenceImageUrls: uniqueStrings(referenceImageUrls).slice(0, 4),
    resolvedReferenceImageCount: countInputImages(content)
  }, logContext);
  const result = await runImageGenerationWithRetry(async (attemptContext) => {
    const attemptMetadata = { ...metadata, ...attemptContext };
    await context.logger.request("codex.image.generate", requestBody, attemptMetadata);
    let response: Response;
    try {
      response = await fetch(normalizeCodexResponsesUrl(context.provider.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          ...codexBackendHeaders(apiKey)
        },
        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      if (isImageGenerationCancellation(error)) throw error;
      throw new ImageGenerationTransportError(error);
    }

    const text = await response.text();
    const payload = parseResponsesSsePayload(text) ?? parseJson(text);
    if (!response.ok) {
      throw new ImageGenerationHttpError(
        response.status,
        payload?.error?.message ?? payload?.detail ?? `Codex image request failed: ${response.status}`,
        summarizeResponsesPayload(payload, text)
      );
    }
    return { payload, text, status: response.status };
  }, {
    sleep: context.options.imageRetrySleep,
    onAttemptFailure: (error, failureContext) => context.logger.imageAttemptFailure(
      "codex.image.generate",
      error,
      failureContext,
      metadata
    )
  });
  const finalMetadata = {
    ...metadata,
    attempt: result.attempt,
    maxAttempts: result.maxAttempts
  };
  try {
    const image = context.imageWriter.write(result.value.payload, imageModel, size);
    await context.logger.response("codex.image.generate", {
      ok: true,
      status: result.value.status,
      summary: summarizeResponsesPayload(result.value.payload, result.value.text),
      image
    }, finalMetadata);
    return image;
  } catch (error) {
    await context.logger.response("codex.image.generate", {
      ok: false,
      status: result.value.status,
      error: errorMessage(error),
      summary: summarizeResponsesPayload(result.value.payload, result.value.text),
      willRetry: false,
      retryDelayMs: 0
    }, finalMetadata);
    throw error;
  }
}

function normalizeImageSize(value: string) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^(\d{3,4})x(\d{3,4})$/);
  if (!match) return "1024x1024";

  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (
    width <= 3840 &&
    height <= 3840 &&
    width % 16 === 0 &&
    height % 16 === 0 &&
    ratio <= 3 &&
    pixels >= 655_360 &&
    pixels <= 8_294_400
  ) {
    return `${width}x${height}`;
  }
  return "1024x1024";
}
