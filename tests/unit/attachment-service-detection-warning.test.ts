// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeAttachmentSourcePort } from "../../packages/testkit/fakeMessagingPort.js";
import { CacheStore } from "../../services/media/attachments/cache.js";
import { AttachmentService } from "../../services/media/attachments/service.js";

let temporaryDirectory = "";

afterEach(async () => {
  vi.restoreAllMocks();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("AttachmentService detection warnings", () => {
  it("keeps readable content but marks a mismatched extension as partial", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "sunabot-detection-warning-"));
    const png = await sharp({
      create: { width: 20, height: 20, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } }
    }).png().toBuffer();
    const gateway = new FakeAttachmentSourcePort({
      kind: "base64",
      base64: png.toString("base64"),
      via: "file_content"
    });
    const cacheRoot = path.join(temporaryDirectory, "cache");
    const attachmentLog = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = new AttachmentService(temporaryDirectory, {
      cacheRoot,
      cacheStore: new CacheStore(cacheRoot, { minimumFreeBytes: 0 })
    });

    const [attachment] = await service.processIncoming([{
      id: "mismatch-1",
      source: "message",
      name: "actually-an-image.txt",
      fileId: "mismatch-file"
    }], gateway);

    expect(attachment).toMatchObject({
      status: "partial",
      format: "png",
      mimeType: "image/png",
      errorCode: "extension_mismatch"
    });
    expect(attachment?.visualPagePaths).toHaveLength(1);
    const logPayload = attachmentLog.mock.calls.find(([label]) => label === "[attachment]")?.[1];
    expect(typeof logPayload).toBe("string");
    expect(JSON.parse(String(logPayload))).toMatchObject({
      event: "attachment_processed",
      attachmentId: "mismatch-1",
      status: "partial",
      format: "png",
      sourceKind: "base64",
      cacheHit: false,
      errorCode: "extension_mismatch"
    });
    expect(String(logPayload)).not.toContain(png.toString("base64"));
  });
});
