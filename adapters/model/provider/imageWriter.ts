import fs from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import sharp from "sharp";
import type { ImageResult } from "../../../packages/contracts/media/media.js";
import { getWorkspacePath } from "../../../packages/platform/projectPaths.js";
import { WORKSPACE_LAYOUT } from "../../../packages/platform/workspaceLayout.js";
import { currentAgentRuntimeConfig } from "../../../packages/platform/runtimeAgentContext.js";
import type { GeneratedImageWriterPort } from "./contracts.js";
import { extractResponsesText } from "./streamDecoder.js";

export class FileGeneratedImageWriter implements GeneratedImageWriterPort {
  async write(payload: unknown, imageModel: string, size: string): Promise<ImageResult> {
    const image = extractGeneratedImage(payload);
    if (!image?.b64Json) {
      const text = extractResponsesText(payload);
      throw new Error(text || "没有收到生图结果。");
    }

    const source = Buffer.from(stripDataUrlPrefix(image.b64Json), "base64");
    const target = parseImageSize(size);
    const bytes = target
      ? await sharp(source)
          .rotate()
          .resize(target.width, target.height, {
            fit: "cover",
            position: "centre",
            kernel: sharp.kernel.lanczos3
          })
          .png()
          .toBuffer()
      : source;
    const agentId = currentAgentRuntimeConfig()?.persona.defaultAgentId.trim() || "plana";
    const imageDir = agentId === "plana"
      ? getWorkspacePath(WORKSPACE_LAYOUT.mediaImages)
      : getWorkspacePath(WORKSPACE_LAYOUT.mediaImages, "agents", agentId);
    await fs.mkdir(imageDir, { recursive: true });
    const fileName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${nanoid(8)}.png`;
    const filePath = path.join(imageDir, fileName);
    await fs.writeFile(filePath, bytes);
    return {
      url: agentId === "plana"
        ? `/generated-images/${fileName}`
        : `/generated-images/agents/${encodeURIComponent(agentId)}/${fileName}`,
      filePath,
      revisedPrompt: `${imageModel} ${size}`
    };
  }
}

function parseImageSize(value: string) {
  const match = String(value).trim().match(/^(\d{3,4})x(\d{3,4})$/u);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return Number.isSafeInteger(width) && Number.isSafeInteger(height)
    ? { width, height }
    : null;
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
