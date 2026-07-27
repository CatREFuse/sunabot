import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PreparedOutboundConversationAssetV1 } from "../../packages/contracts/messaging/messages.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { getWorkspacePath } from "../../packages/platform/projectPaths.js";

const IMAGE_EXTENSIONS_BY_MIME = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/tiff", "tiff"],
  ["image/bmp", "bmp"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["image/flif", "flif"],
  ["image/x-flif", "flif"],
  ["image/jxl", "jxl"],
  ["image/vnd.ms-photo", "jxr"],
  ["image/vnd.adobe.photoshop", "psd"],
  ["image/x-icon", "ico"],
  ["image/vnd.microsoft.icon", "ico"],
  ["image/x-canon-cr2", "cr2"],
  ["image/x-adobe-dng", "dng"],
  ["image/x-sony-arw", "arw"],
  ["image/ktx", "ktx"],
  ["image/ktx2", "ktx2"]
]);

export async function archiveConversationImage(
  agentId: string,
  prepared: PreparedOutboundConversationAssetV1,
  mediaRoot = getWorkspacePath(WORKSPACE_LAYOUT.mediaImages)
) {
  const normalizedAgentId = agentId.trim();
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(normalizedAgentId)) {
    throw new Error("Conversation image Agent ID is invalid.");
  }
  if (prepared.kind !== "image") {
    throw new Error("Conversation image archive only accepts image assets.");
  }
  const mimeType = String(prepared.mimeType ?? "").trim().toLowerCase();
  const extension = IMAGE_EXTENSIONS_BY_MIME.get(mimeType);
  if (!extension) {
    throw new Error("Conversation image format is unsupported.");
  }
  const expectedDigest = String(prepared.sha256 ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error("Conversation image digest is invalid.");
  }
  const bytes = decodePreparedImage(prepared.source);
  if (bytes.byteLength !== prepared.byteLength) {
    throw new Error("Conversation image byte length changed.");
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expectedDigest) {
    throw new Error("Conversation image digest changed.");
  }

  const directory = path.join(
    mediaRoot,
    "conversation-assets",
    "agents",
    normalizedAgentId
  );
  const fileName = `${digest}.${extension}`;
  const filePath = path.join(directory, fileName);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (!await matchingArchiveExists(filePath, bytes.byteLength, digest)) {
    await writeArchiveAtomically(directory, filePath, bytes, digest);
  }
  return `/generated-images/conversation-assets/agents/${encodeURIComponent(normalizedAgentId)}/${fileName}`;
}

function decodePreparedImage(source: string) {
  if (!source.startsWith("base64://")) {
    throw new Error("Conversation image source is invalid.");
  }
  const encoded = source.slice("base64://".length);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Conversation image source is invalid.");
  }
  return Buffer.from(encoded, "base64");
}

async function matchingArchiveExists(filePath: string, byteLength: number, digest: string) {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size !== byteLength) {
      throw new Error("Conversation image archive is unsafe.");
    }
    const bytes = await fs.readFile(filePath);
    if (createHash("sha256").update(bytes).digest("hex") !== digest) {
      throw new Error("Conversation image archive digest mismatch.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeArchiveAtomically(
  directory: string,
  filePath: string,
  bytes: Buffer,
  digest: string
) {
  const temporaryPath = path.join(directory, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.link(temporaryPath, filePath);
    await fs.unlink(temporaryPath);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.unlink(temporaryPath).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      if (await matchingArchiveExists(filePath, bytes.byteLength, digest)) return;
    }
    throw error;
  }
}
