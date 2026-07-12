// @vitest-environment node
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import {
  OutboundMediaDelivery,
  outboundMediaMaxInlineBytes,
  outboundMediaReferenceMode
} from "../../services/delivery/outboundMedia.js";

describe("OneBot outbound media adapter", () => {
  let temporaryDirectory = "";
  let imagePath = "";
  let delivery: OutboundMediaDelivery;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-onebot-media-"));
    imagePath = path.join(temporaryDirectory, "generated.png");
    await fs.writeFile(imagePath, Buffer.from("generated-image"));
    delivery = new OutboundMediaDelivery({
      rootDir: temporaryDirectory,
      referenceMode: "shared-path"
    });
  });

  afterEach(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("maps internal image assets to local paths when NapCat shares the filesystem", async () => {
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) },
      { outboundMedia: delivery }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await gateway.sendGroupRichMessage(42, "生成完成", [{
      url: "/generated-images/generated.png",
      filePath: imagePath
    }], { replyToMessageId: 7 });

    expect(sendAction).toHaveBeenCalledOnce();
    const [action, params] = sendAction.mock.calls[0]!;
    const message = params.message as Array<{ type: string; data: Record<string, string> }>;
    expect(action).toBe("send_group_msg");
    expect(params.group_id).toBe(42);
    expect(message.map((segment) => segment.type)).toEqual(["reply", "text", "image"]);
    const source = message[2]!.data.file;
    expect(source).toBe(imagePath);
  });

  it("passes external HTTP image assets through the standard OneBot interface", async () => {
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) },
      { outboundMedia: delivery }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await gateway.sendPrivateRichMessage(99, "外部图片", [{ url: "https://cdn.example.test/image.png" }]);

    const params = sendAction.mock.calls[0]![1];
    const message = params.message as Array<{ type: string; data: Record<string, string> }>;
    expect(message.at(-1)).toEqual({
      type: "image",
      data: { file: "https://cdn.example.test/image.png" }
    });
  });

  it("uses bounded inline OneBot image data by default in every topology", async () => {
    const inlineDelivery = new OutboundMediaDelivery({
      rootDir: temporaryDirectory
    });

    await expect(inlineDelivery.createReference(imagePath)).resolves.toBe(
      `base64://${Buffer.from("generated-image").toString("base64")}`
    );
    expect(outboundMediaReferenceMode({})).toBe("inline-base64");
    expect(() => outboundMediaReferenceMode({ SUNABOT_MEDIA_TRANSPORT: "shared-path" })).toThrow(
      "do not share a filesystem"
    );
  });

  it("rejects invalid transport configuration and oversized inline files", async () => {
    expect(() => outboundMediaReferenceMode({ SUNABOT_MEDIA_TRANSPORT: "platform-default" })).toThrow(
      "SUNABOT_MEDIA_TRANSPORT"
    );
    expect(() => outboundMediaMaxInlineBytes({ SUNABOT_MEDIA_MAX_INLINE_BYTES: "0" })).toThrow(
      "SUNABOT_MEDIA_MAX_INLINE_BYTES"
    );
    const boundedDelivery = new OutboundMediaDelivery({
      rootDir: temporaryDirectory,
      maxInlineBytes: 4
    });
    await expect(boundedDelivery.createReference(imagePath)).rejects.toThrow(
      "exceeds the inline Base64 limit of 4 bytes"
    );
  });
});
