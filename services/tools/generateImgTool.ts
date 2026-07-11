import { ImageResult, BotConfig, ImageQuality } from "../../src/types.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";

export const GENERATE_IMG_TOOL_NAME = "generate_img";
export type ImageResolution = BotConfig["tools"]["generateImg"]["resolution"];

export interface GenerateImgInput {
  prompt?: unknown;
  size?: unknown;
  resolution?: unknown;
  quality?: unknown;
  referenceImageUrls?: unknown;
}

export type GenerateImageRunner = (
  prompt: string,
  size: string,
  quality: ImageQuality,
  referenceImageUrls?: string[],
  logContext?: ProviderLogContext
) => Promise<ImageResult>;

export interface GenerateImgRunOptions {
  referenceImageUrls?: string[];
  logContext?: ProviderLogContext;
}

export const generateImgTool = {
  type: "function",
  name: GENERATE_IMG_TOOL_NAME,
  description: "Generate or edit an image from a prompt. Default clarity is 1K. Use resolution 2K or 4K only when the user asks for higher resolution, clearer output, wallpaper, poster, print, or explicitly says 2K/4K. Current and quoted message images are supplied as reference images when available. Returns the saved image metadata. The system sends generated images separately; do not print local file paths or CQ codes.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt: {
        type: "string",
        description: "The image prompt."
      },
      size: {
        type: ["string", "null"],
        enum: [
          "1024x1024",
          "1536x1024",
          "1024x1536",
          "2048x2048",
          "2048x1152",
          "1152x2048",
          "3840x2160",
          "2160x3840",
          null
        ],
        description: "Image size in gpt-image-2/Codex image_generation format. Use null to choose from resolution and the configured default aspect."
      },
      resolution: {
        type: ["string", "null"],
        enum: ["1K", "2K", "4K", null],
        description: "Output clarity. Default is 1K. Use 2K or 4K only when the user explicitly asks for higher resolution, clearer detail, wallpaper, poster, print, or names 2K/4K."
      },
      quality: {
        type: ["string", "null"],
        enum: ["auto", "low", "medium", "high", null],
        description: "Rendering quality. Use high when the user asks for high quality, highest quality, best quality, maximum detail, or equivalent wording. Use null to apply the configured default."
      },
      referenceImageUrls: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: 4,
        description: "Reference image URLs to use. Use null to use the current message images."
      }
    },
    required: ["prompt", "size", "resolution", "quality", "referenceImageUrls"]
  },
  strict: true
};

export async function runGenerateImg(
  input: GenerateImgInput,
  botConfig: BotConfig,
  generateImage?: GenerateImageRunner,
  options: GenerateImgRunOptions = {}
) {
  if (botConfig.tools.generateImg.provider === "custom") {
    return { ok: false, error: "自定义生图暂不支持。" };
  }
  if (!generateImage) {
    return { ok: false, error: "Image generation is not configured." };
  }

  const prompt = normalizePrompt(input.prompt);
  if (!prompt) {
    return { ok: false, error: "Image prompt is empty." };
  }

  const resolution = normalizeImageResolution(input.resolution, botConfig.tools.generateImg.resolution);
  const size = normalizeImageSize(input.size, botConfig.tools.generateImg.size, resolution);
  const quality = normalizeImageQuality(input.quality, botConfig.tools.generateImg.quality);
  const explicitReferenceImageUrls = normalizeReferenceImageUrls(input.referenceImageUrls);
  const referenceImageUrls = explicitReferenceImageUrls.length ? explicitReferenceImageUrls : normalizeReferenceImageUrls(options.referenceImageUrls);
  const image = await generateImage(prompt, size, quality, referenceImageUrls, options.logContext);
  return {
    ok: true,
    provider: "codex-image-gen",
    prompt,
    size,
    resolution,
    quality,
    referenceImageCount: referenceImageUrls.length,
    image
  };
}

function normalizePrompt(value: unknown) {
  return String(value ?? "").trim().slice(0, 4_000);
}

function normalizeImageSize(
  value: unknown,
  fallback: BotConfig["tools"]["generateImg"]["size"],
  resolution: ImageResolution
) {
  if (isImageSize(value)) return value;
  return sizeForResolution(fallback, resolution);
}

function normalizeImageResolution(value: unknown, fallback: ImageResolution) {
  return value === "2K" || value === "4K" || value === "1K" ? value : fallback;
}

function normalizeImageQuality(value: unknown, fallback: ImageQuality) {
  return value === "auto" || value === "low" || value === "medium" || value === "high" ? value : fallback;
}

function sizeForResolution(size: BotConfig["tools"]["generateImg"]["size"], resolution: ImageResolution) {
  const aspect = imageAspect(size);
  if (resolution === "4K") return aspect === "portrait" ? "2160x3840" : "3840x2160";
  if (resolution === "2K") return aspect === "portrait" ? "1152x2048" : aspect === "landscape" ? "2048x1152" : "2048x2048";
  return aspect === "portrait" ? "1024x1536" : aspect === "landscape" ? "1536x1024" : "1024x1024";
}

function imageAspect(size: string) {
  const [width = 0, height = 0] = size.split("x").map((item) => Number(item));
  if (width > height) return "landscape";
  if (height > width) return "portrait";
  return "square";
}

function isImageSize(value: unknown): value is BotConfig["tools"]["generateImg"]["size"] {
  return value === "1024x1024" ||
    value === "1536x1024" ||
    value === "1024x1536" ||
    value === "2048x2048" ||
    value === "2048x1152" ||
    value === "1152x2048" ||
    value === "3840x2160" ||
    value === "2160x3840";
}

function normalizeReferenceImageUrls(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))]
    .slice(0, 4);
}
