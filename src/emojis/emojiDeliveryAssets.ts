import crypto from "node:crypto";
import sharp from "sharp";
import type { ImageResult } from "../../packages/contracts/media/media.js";
import type { EmojiMarkerPlan } from "../../services/emojis/emojiCatalog.js";
import { writeContentAddressedEmojiPng } from "../admin/emojiFileIo.js";
import type { AppConfig } from "../types.js";
import {
  assertPlannedEmojiAssetsIntegrity,
  emojiMediaLocation,
  readPlannedEmojiAssets
} from "./emojiAssets.js";

const MAX_EMOJI_INPUT_PIXELS = 64_000_000;
const resizeInFlight = new Map<string, Promise<ImageResult>>();

export async function prepareEmojiDeliveryImages(
  config: AppConfig,
  plan: EmojiMarkerPlan
): Promise<ImageResult[]> {
  if (!plan.expectedImages.length) return [];
  if (config.bot.emojiSendSize === 1024) {
    await assertPlannedEmojiAssetsIntegrity(config, plan);
    return plan.expectedImages.map((image) => ({ ...image }));
  }
  const assets = await readPlannedEmojiAssets(config, plan);
  const resolved = new Map<string, ImageResult>();
  for (const asset of assets) {
    let image = resolved.get(asset.record.fileName);
    if (!image) {
      image = await resizedEmoji(config, asset.record.fileName, asset.bytes);
      resolved.set(asset.record.fileName, image);
    }
  }
  return assets.map((asset) => ({ ...resolved.get(asset.record.fileName)! }));
}

function resizedEmoji(config: AppConfig, sourceFileName: string, sourceBytes: Buffer) {
  const agentId = config.persona.defaultAgentId.trim() || "plana";
  const operationKey = `${agentId}\0${sourceFileName}\0${config.bot.emojiSendSize}`;
  const existing = resizeInFlight.get(operationKey);
  if (existing) return existing;
  const operation = createResizedEmoji(config, sourceBytes).finally(() => {
    if (resizeInFlight.get(operationKey) === operation) resizeInFlight.delete(operationKey);
  });
  resizeInFlight.set(operationKey, operation);
  return operation;
}

async function createResizedEmoji(config: AppConfig, sourceBytes: Buffer): Promise<ImageResult> {
  const size = config.bot.emojiSendSize;
  let resized: Buffer;
  try {
    const output = await sharp(sourceBytes, {
      animated: false,
      page: 0,
      pages: 1,
      failOn: "error",
      limitInputPixels: MAX_EMOJI_INPUT_PIXELS
    })
      .resize({ width: size, height: size, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
    if (output.info.width > size || output.info.height > size) throw new Error("Emoji resize exceeded configured size.");
    resized = output.data;
  } catch {
    throw new Error("表情图片缩放失败。");
  }
  const hash = crypto.createHash("sha256").update(resized).digest("hex");
  const fileName = `emoji-${hash}.png`;
  const location = emojiMediaLocation(config, fileName);
  await writeContentAddressedEmojiPng(location.filePath, resized, hash, {});
  return { url: location.url, filePath: location.filePath };
}
