import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { ImageResult } from "../../../src/types.js";
import { getWorkspacePath } from "../../../src/config.js";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import type { GeneratedImageWriterPort } from "./contracts.js";
import { extractResponsesText } from "./streamDecoder.js";

export class FileGeneratedImageWriter implements GeneratedImageWriterPort {
  write(payload: unknown, imageModel: string, size: string): ImageResult {
    const image = extractGeneratedImage(payload);
    if (!image?.b64Json) {
      const text = extractResponsesText(payload);
      throw new Error(text || "没有收到生图结果。");
    }

    const imageDir = getWorkspacePath(WORKSPACE_LAYOUT.mediaImages);
    fs.mkdirSync(imageDir, { recursive: true });
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${nanoid(8)}.png`;
    const filePath = path.join(imageDir, fileName);
    fs.writeFileSync(filePath, Buffer.from(stripDataUrlPrefix(image.b64Json), "base64"));
    return {
      url: `/generated-images/${fileName}`,
      filePath,
      revisedPrompt: `${imageModel} ${size}`
    };
  }
}

function extractGeneratedImage(payload: unknown) {
  const response = payload as { output?: Array<Record<string, unknown>> };
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "image_generation_call") continue;
    const b64Json = String(item.result ?? item.image ?? item.b64_json ?? item.partial_image_b64 ?? "").trim();
    if (b64Json) {
      return {
        b64Json,
        mimeType: String(item.mime_type ?? item.mimeType ?? "image/png")
      };
    }
  }
  return null;
}

function stripDataUrlPrefix(value: string) {
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, "");
}
