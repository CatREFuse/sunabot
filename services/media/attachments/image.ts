import sharp, { type SharpOptions } from "sharp";

export const MAX_MODEL_IMAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_IMAGE_MAX_LONG_EDGE = 2_048;
export const DEFAULT_IMAGE_MAX_PIXELS = 16_000_000;
export const DEFAULT_IMAGE_INPUT_PIXEL_LIMIT = 64_000_000;

export interface NormalizeAttachmentImageOptions {
  maxBytes?: number;
  maxLongEdge?: number;
  maxPixels?: number;
  inputPixelLimit?: number;
  jpegQuality?: number;
}

export interface NormalizedAttachmentImage {
  bytes: Buffer;
  contentType: "image/jpeg" | "image/png";
  format: "jpeg" | "png";
  width: number;
  height: number;
  resized: boolean;
  sourcePages: number;
}

export async function normalizeAttachmentImage(
  input: string | Uint8Array,
  options: NormalizeAttachmentImageOptions = {}
): Promise<NormalizedAttachmentImage> {
  const maxBytes = positiveInteger(options.maxBytes, MAX_MODEL_IMAGE_BYTES, "maxBytes");
  const maxLongEdge = positiveInteger(options.maxLongEdge, DEFAULT_IMAGE_MAX_LONG_EDGE, "maxLongEdge");
  const maxPixels = positiveInteger(options.maxPixels, DEFAULT_IMAGE_MAX_PIXELS, "maxPixels");
  const inputPixelLimit = positiveInteger(
    options.inputPixelLimit,
    DEFAULT_IMAGE_INPUT_PIXEL_LIMIT,
    "inputPixelLimit"
  );
  const jpegQuality = boundedInteger(options.jpegQuality, 85, 20, 100, "jpegQuality");
  const sharpInput = typeof input === "string" ? input : Buffer.from(input);
  const constructorOptions: SharpOptions = {
    animated: false,
    page: 0,
    pages: 1,
    failOn: "error",
    limitInputPixels: inputPixelLimit
  };
  const metadata = await sharp(sharpInput, constructorOptions).metadata();
  if (!metadata.width || !metadata.height) throw new Error("Image dimensions are unavailable");

  const swapsDimensions = metadata.orientation != null && metadata.orientation >= 5 && metadata.orientation <= 8;
  const sourceWidth = swapsDimensions ? metadata.height : metadata.width;
  const sourceHeight = swapsDimensions ? metadata.width : metadata.height;
  const initialScale = Math.min(
    1,
    maxLongEdge / Math.max(sourceWidth, sourceHeight),
    Math.sqrt(maxPixels / (sourceWidth * sourceHeight))
  );
  let width = Math.max(1, Math.floor(sourceWidth * initialScale));
  let height = Math.max(1, Math.floor(sourceHeight * initialScale));
  const preserveAlpha = metadata.hasAlpha === true;
  const sourcePages = Math.max(1, metadata.pages ?? 1);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const pipeline = sharp(sharpInput, constructorOptions)
      .rotate()
      .resize({ width, height, fit: "inside", withoutEnlargement: true });
    const bytes = preserveAlpha
      ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : await pipeline.jpeg({ quality: Math.max(35, jpegQuality - attempt * 4), mozjpeg: true }).toBuffer();
    if (bytes.byteLength <= maxBytes) {
      const outputMetadata = await sharp(bytes).metadata();
      return {
        bytes,
        contentType: preserveAlpha ? "image/png" : "image/jpeg",
        format: preserveAlpha ? "png" : "jpeg",
        width: outputMetadata.width ?? width,
        height: outputMetadata.height ?? height,
        resized: width < sourceWidth || height < sourceHeight,
        sourcePages
      };
    }

    if (width === 1 && height === 1) break;
    width = Math.max(1, Math.floor(width * 0.8));
    height = Math.max(1, Math.floor(height * 0.8));
  }

  throw new Error(`Image cannot be normalized below ${maxBytes} bytes`);
}

function positiveInteger(value: number | undefined, fallback: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new RangeError(`${name} must be a positive integer`);
  return result;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}
