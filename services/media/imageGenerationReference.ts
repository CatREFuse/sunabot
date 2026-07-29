import {
  normalizeAttachmentImage,
  type NormalizedAttachmentImage
} from "./attachments/image.js";

export const IMAGE_GENERATION_REFERENCE_MAX_BYTES = 16 * 1024 * 1024;
export const IMAGE_GENERATION_REFERENCE_MAX_LONG_EDGE = 3_840;
export const IMAGE_GENERATION_REFERENCE_MAX_PIXELS = 8_294_400;

export async function normalizeImageGenerationReference(
  input: string | Uint8Array
): Promise<NormalizedAttachmentImage> {
  return normalizeAttachmentImage(input, {
    maxBytes: IMAGE_GENERATION_REFERENCE_MAX_BYTES,
    maxLongEdge: IMAGE_GENERATION_REFERENCE_MAX_LONG_EDGE,
    maxPixels: IMAGE_GENERATION_REFERENCE_MAX_PIXELS,
    inputPixelLimit: 64_000_000,
    jpegQuality: 92
  });
}
