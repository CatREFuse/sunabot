import { ImageQuality, ImageResult } from "./types.js";

export const SELFIE_TOOL_NAME = "selfie";

export interface SelfieInput {
  prompt?: unknown;
  size?: unknown;
  resolution?: unknown;
  quality?: unknown;
  referenceImageUrls?: unknown;
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

export const selfieTool = {
  type: "function",
  name: SELFIE_TOOL_NAME,
  description: "Generate a selfie or broad image of the bot's own appearance. Use when the user asks the bot to show itself, take a selfie, make an avatar, make a photo with the bot, or make the bot hold/wear/use something from chat images. A selfie can be interpreted broadly as any image where the bot's own appearance is present, not only a phone selfie pose. Stored bot selfie references are always supplied; current, quoted, and recent chat images are also supplied when available. Do not print local file paths or CQ codes.",
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
        maxItems: 4,
        description: "Optional chat reference image URLs. Use null to use current, quoted, and recent chat images automatically."
      }
    },
    required: ["prompt", "size", "resolution", "quality", "referenceImageUrls"]
  },
  strict: true
};
