import type { ImageQuality } from "../../packages/contracts/admin/public.js";
import type { ImageResult } from "../../packages/contracts/media/media.js";
import { GENERATE_IMG_REFERENCE_SOURCES } from "./generateImgTool.js";

export const SELFIE_TOOL_NAME = "selfie";

export interface SelfieInput {
  prompt?: unknown;
  size?: unknown;
  resolution?: unknown;
  quality?: unknown;
  referenceImageUrls?: unknown;
  referenceImagePaths?: unknown;
  referenceMediaHandles?: unknown;
  referenceImageSource?: unknown;
}

export type SelfieRunner = (input: SelfieInput) => Promise<SelfieRunResult>;

export type SelfieRunResult =
  | {
    ok: true;
    provider: "codex-image-gen";
    prompt: string;
    rewrittenPrompt: string;
    size: string;
    resolution: string;
    quality: ImageQuality;
    referenceImageCount: number;
    workspaceReferenceImageCount: number;
    chatReferenceImageCount: number;
    image: ImageResult;
  }
  | {
    ok: false;
    error: string;
  };

export const LEGACY_SELFIE_TOOL_DESCRIPTION = "Generate a selfie or broad image of the bot's own appearance. Use when the user asks the bot to show itself, take a selfie, make an avatar, make a photo with the bot, or make the bot hold/wear/use something from chat images. A selfie can be interpreted broadly as any image where the bot's own appearance is present, not only a phone selfie pose. The selfie prompt node selects 1 to 3 stored bot references from the configured catalog by their notes. The model decides whether one additional external reference is needed: select at most one exact historical media handle, current-workbench image path, explicit URL, or automatic chat source, in that priority order. Workbench paths may be relative or the exact authorized absolute path returned by Native or Docker Bash. Use previous_output for edits or retries of the latest generated image, history for earlier same-user media, current for current or quoted media, current_and_history to combine them, and none when only stored bot references are needed. Do not print local file paths or CQ codes.";

export const selfieTool = {
  type: "function",
  name: SELFIE_TOOL_NAME,
  description: "Generate a selfie or broad image of the bot's own appearance. Use when the user asks the bot to show itself, take a selfie, make an avatar, make a photo with the bot, or make the bot hold, wear, or use something from chat images. A selfie can be interpreted broadly as any image where the bot's own appearance is present, not only a phone selfie pose. The selfie prompt node selects 1 to 3 stored bot references from the configured catalog by their notes. When the scene also requires a particular person, film or anime character, or non-public object whose appearance is not already established by current or historical media, first use webfetch or knowledge_search to find an actual reference image, use Bash to save it under the authorized workbench when needed, and pass that exact reference. A reference image is mandatory in that situation; never generate an unknown appearance from text alone. The model decides whether one additional external reference is needed: select at most one exact historical media handle, current-workbench image path, explicit URL, or automatic chat source, in that priority order. Workbench paths may be relative, including portable knowledge/... paths, or the exact authorized absolute path returned by Native or Docker Bash. Use previous_output for edits or retries of the latest generated image, history for earlier same-user media, current for current or quoted media, current_and_history to combine them, and none when only stored bot references are needed. Do not print local file paths or CQ codes.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      prompt: {
        type: "string",
        description: "The requested scene, mood, outfit, or composition involving the bot's own appearance. Avoid default raised-hand or phone-selfie poses unless requested."
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
        maxItems: 1,
        description: "At most one exact reference image URL explicitly present in the request. Use null when selecting a workbench image, conversation media, or automatic history. Do not invent URLs."
      },
      referenceImagePaths: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: 1,
        description: "At most one path of an existing image in the current authorized workbench, including a portable knowledge/... path. Pass either a workbench-relative path or the exact absolute path returned by Bash. Native absolute paths must remain under the current Agent workbench; Docker absolute paths use /workbench, including /workbench/native-workbench for its read-only Native projection. Never pass a URL, media handle, Base64 value, guessed path, or a path outside those roots. Use null when no workbench image is needed."
      },
      referenceMediaHandles: {
        type: ["array", "null"],
        items: { type: "string" },
        maxItems: 1,
        description: "At most one exact historical media handle shown in conversation history, such as message:<message-id>:image:<index>. Prefer this handle when the user refers to a specific earlier image. Use null when no exact chat image is needed. Do not invent handles."
      },
      referenceImageSource: {
        type: "string",
        enum: GENERATE_IMG_REFERENCE_SOURCES,
        description: "Fallback chat reference source chosen by the model: none adds no chat media; current uses current and quoted images; previous_output uses the same user's latest generated output; history uses recent same-user conversation media; current_and_history combines current and recent same-user media. The prompt node independently chooses 1 to 3 stored bot references."
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
