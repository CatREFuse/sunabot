import type { BotConfig, ImageQuality } from "../../packages/contracts/admin/public.js";
import type { ImageResult } from "../../packages/contracts/media/media.js";
import type { ProviderLogContext } from "../../packages/contracts/model/modelGateway.js";

export const GENERATE_IMG_TOOL_NAME = "generate_img";
export const GENERATE_IMG_REFERENCE_SOURCES = [
  "none",
  "current",
  "previous_output",
  "history",
  "current_and_history"
] as const;
export type GenerateImgReferenceSource = typeof GENERATE_IMG_REFERENCE_SOURCES[number];

export interface GenerateImgReferenceContext {
  currentImageUrls?: readonly string[];
  previousOutputImageUrls?: readonly string[];
  historyImageUrls?: readonly string[];
  mediaByHandle?: Readonly<Record<string, string>>;
}

export type ImageResolution = BotConfig["tools"]["generateImg"]["resolution"];

export interface GenerateImgInput {
  prompt?: unknown;
  size?: unknown;
  resolution?: unknown;
  quality?: unknown;
  referenceImageUrls?: unknown;
  referenceImagePaths?: unknown;
  referenceMediaHandles?: unknown;
  referenceImageSource?: unknown;
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
  imageReferences?: GenerateImgReferenceContext;
  resolveWorkbenchImagePaths?: WorkbenchImagePathResolver;
  logContext?: ProviderLogContext;
}

export type WorkbenchImagePathResolver = (paths: readonly string[]) => Promise<string[]>;

export interface ResolvedGenerateImgReferences {
  referenceImageSource: GenerateImgReferenceSource;
  referenceImagePaths: string[];
  resolvedWorkbenchImageUrls: string[];
  referenceMediaHandles: string[];
  resolvedHandleImageUrls: string[];
  referenceImageUrls: string[];
}

export const generateImgTool = {
  type: "function",
  name: GENERATE_IMG_TOOL_NAME,
  description: "Generate or edit an image from a prompt. The model must decide every image parameter and whether reference media is needed. It can pass current-workbench images directly through referenceImagePaths, using either a relative path or the exact authorized absolute path returned by Bash. Native Bash absolute paths must remain inside the current Agent workbench; Docker Bash paths use /workbench or its native-workbench read-only projection. Prefer exact historical media handles shown in conversation history when the user identifies a sent or received chat image; use referenceImageSource as a fallback when no exact handle is suitable. Use previous_output for edits or retries of the last generated image, history for earlier same-user media, current for current or quoted media, current_and_history to combine them, and none for a fresh image. Resolved historical media handles have highest priority, followed by resolved workbench paths. Default clarity is 1K. Use resolution 2K or 4K only when the user asks for higher resolution, clearer output, wallpaper, poster, print, or explicitly says 2K/4K. Returns the saved image metadata. The system sends generated images separately; do not print local file paths or CQ codes.",
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
        description: "Exact reference image URLs explicitly present in the request. Use null when selecting current-workbench images, conversation media, or automatic history. Do not invent URLs."
      },
      referenceImagePaths: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: 4,
        description: "Paths of existing images in the current authorized workbench. Pass either a workbench-relative path or the exact absolute path returned by Bash. Native absolute paths must remain under the current Agent workbench; Docker absolute paths use /workbench, including /workbench/native-workbench for its read-only Native projection. Never pass a URL, media handle, Base64 value, guessed path, or a path outside those roots. Use null when no workbench image is needed."
      },
      referenceMediaHandles: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: 4,
        description: "Exact historical media handles shown in conversation history, such as message:<message-id>:image:<index>. Prefer these handles when the user refers to a specific earlier image. Use null when no exact historical image is needed. Do not invent handles."
      },
      referenceImageSource: {
        type: "string",
        enum: GENERATE_IMG_REFERENCE_SOURCES,
        description: "Fallback reference source chosen by the model: none uses no automatic media; current uses current and quoted images; previous_output uses the same user's latest generated output; history uses recent same-user conversation media; current_and_history combines current and recent same-user media."
      }
    },
    required: [
      "prompt",
      "size",
      "resolution",
      "quality",
      "referenceImageUrls",
      "referenceImagePaths",
      "referenceMediaHandles",
      "referenceImageSource"
    ]
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
  const references = await resolveGenerateImgReferencesForRun(input, options);
  const image = await generateImage(prompt, size, quality, references.referenceImageUrls, options.logContext);
  return {
    ok: true,
    provider: "codex-image-gen",
    prompt,
    size,
    resolution,
    quality,
    referenceImageSource: references.referenceImageSource,
    referenceImagePathCount: references.referenceImagePaths.length,
    resolvedReferenceImagePathCount: references.resolvedWorkbenchImageUrls.length,
    referenceMediaHandleCount: references.referenceMediaHandles.length,
    resolvedReferenceMediaHandleCount: references.resolvedHandleImageUrls.length,
    referenceImageCount: references.referenceImageUrls.length,
    image
  };
}

export function resolveGenerateImgReferences(
  input: Pick<GenerateImgInput, "referenceImageUrls" | "referenceMediaHandles" | "referenceImageSource">,
  options: GenerateImgRunOptions = {}
): ResolvedGenerateImgReferences {
  const explicitReferenceImageUrls = normalizeReferenceImageUrls(input.referenceImageUrls);
  const referenceMediaHandles = normalizeReferenceMediaHandles(input.referenceMediaHandles);
  const referenceImageSource = normalizeReferenceImageSource(input.referenceImageSource);
  const configuredReferences = options.imageReferences ?? {
    currentImageUrls: options.referenceImageUrls
  };
  const imageReferences = input.referenceImageSource == null && options.referenceImageUrls?.length
    ? { ...configuredReferences, currentImageUrls: options.referenceImageUrls }
    : configuredReferences;
  const resolvedHandleImageUrls = normalizeReferenceImageUrls(referenceMediaHandles
    .map((handle) => imageReferences.mediaByHandle?.[handle]));
  const automaticReferenceImageUrls = selectedAutomaticReferenceImageUrls(
    referenceImageSource,
    imageReferences,
    input.referenceImageSource == null && explicitReferenceImageUrls.length > 0
  );
  return {
    referenceImageSource,
    referenceImagePaths: [],
    resolvedWorkbenchImageUrls: [],
    referenceMediaHandles,
    resolvedHandleImageUrls,
    referenceImageUrls: normalizeReferenceImageUrls([
      ...resolvedHandleImageUrls,
      ...explicitReferenceImageUrls,
      ...automaticReferenceImageUrls
    ])
  };
}

export async function resolveGenerateImgReferencesForRun(
  input: Pick<GenerateImgInput, "referenceImageUrls" | "referenceImagePaths" | "referenceMediaHandles" | "referenceImageSource">,
  options: GenerateImgRunOptions = {}
): Promise<ResolvedGenerateImgReferences> {
  const references = resolveGenerateImgReferences(input, options);
  const referenceImagePaths = normalizeReferenceImagePaths(input.referenceImagePaths);
  const resolvedWorkbenchImageUrls = options.resolveWorkbenchImagePaths && referenceImagePaths.length
    ? normalizeReferenceImageUrls(await options.resolveWorkbenchImagePaths(referenceImagePaths))
    : [];
  return {
    ...references,
    referenceImagePaths,
    resolvedWorkbenchImageUrls,
    referenceImageUrls: normalizeReferenceImageUrls([
      ...references.resolvedHandleImageUrls,
      ...resolvedWorkbenchImageUrls,
      ...references.referenceImageUrls
    ])
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

function normalizeReferenceMediaHandles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))]
    .slice(0, 4);
}

function normalizeReferenceImagePaths(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean))]
    .slice(0, 4);
}

function normalizeReferenceImageSource(value: unknown): GenerateImgReferenceSource {
  if ((GENERATE_IMG_REFERENCE_SOURCES as readonly unknown[]).includes(value)) {
    return value as GenerateImgReferenceSource;
  }
  return value == null ? "current" : "none";
}

function selectedAutomaticReferenceImageUrls(
  source: GenerateImgReferenceSource,
  references: GenerateImgReferenceContext,
  preserveLegacyExplicitOverride: boolean
) {
  if (preserveLegacyExplicitOverride) return [];
  const current = normalizeReferenceImageUrls(references.currentImageUrls);
  const previousOutput = normalizeReferenceImageUrls(references.previousOutputImageUrls);
  const history = normalizeReferenceImageUrls(references.historyImageUrls);
  if (source === "current") return current;
  if (source === "previous_output") return previousOutput;
  if (source === "history") return history;
  if (source === "current_and_history") return normalizeReferenceImageUrls([...current, ...history]);
  return [];
}

export function generateImgMediaHandle(messageId: string, imageIndex: number) {
  return `message:${encodeURIComponent(messageId)}:image:${imageIndex}`;
}
