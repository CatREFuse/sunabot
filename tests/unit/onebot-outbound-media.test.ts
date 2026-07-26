// @vitest-environment node
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import { MAX_EMOJI_MARKERS_PER_REPLY } from "../../services/emojis/public.js";
import {
  MAX_OUTBOUND_INLINE_EMOJI_BYTES_PER_MESSAGE,
  OutboundMediaDelivery,
  outboundMediaMaxInlineBytes,
  outboundMediaReferenceMode
} from "../../services/delivery/outboundMedia.js";

describe("OneBot outbound media adapter", () => {
  let temporaryDirectory = "";
  let imagePath = "";
  let agentImagePath = "";
  let delivery: OutboundMediaDelivery;

  beforeEach(async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-onebot-media-"));
    imagePath = path.join(temporaryDirectory, "generated.png");
    agentImagePath = path.join(temporaryDirectory, "agents", "arona", "generated.png");
    await fs.mkdir(path.dirname(agentImagePath), { recursive: true });
    await fs.writeFile(imagePath, Buffer.from("generated-image"));
    await fs.writeFile(agentImagePath, Buffer.from("agent-generated-image"));
    delivery = new OutboundMediaDelivery({
      rootDir: temporaryDirectory,
      referenceMode: "shared-path"
    });
  });

  afterEach(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("always sends plain text as a structured segment", async () => {
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await gateway.sendPrivateMessage(99, "[CQ:at,qq=all]纯文本", "primary");

    expect(sendAction.mock.calls[0]?.[1]).toMatchObject({
      user_id: 99,
      message: [{ type: "text", data: { text: "[CQ:at,qq=all]纯文本" } }]
    });
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
    await expect(inlineDelivery.createReference(agentImagePath)).resolves.toBe(
      `base64://${Buffer.from("agent-generated-image").toString("base64")}`
    );
    expect(outboundMediaReferenceMode({})).toBe("inline-base64");
    expect(() => outboundMediaReferenceMode({ SUNABOT_MEDIA_TRANSPORT: "shared-path" })).toThrow(
      "do not share a filesystem"
    );
  });

  it("accepts only content-addressed emoji PNGs and GIFs from an Agent workbench", async () => {
    const workspaceRoot = path.join(temporaryDirectory, "workspace");
    const generatedRoot = path.join(workspaceRoot, "business", "media", "images");
    const emojiRoot = path.join(workspaceRoot, "business", "agents", "arona", "workbench", "emoji");
    const content = Buffer.from("workbench-emoji");
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const emojiPath = path.join(emojiRoot, `emoji-${digest}.png`);
    const gifPath = path.join(emojiRoot, `emoji-${digest}.gif`);
    const arbitraryPath = path.join(emojiRoot, "arbitrary.png");
    await fs.mkdir(generatedRoot, { recursive: true });
    await fs.mkdir(emojiRoot, { recursive: true });
    await fs.writeFile(emojiPath, content);
    await fs.writeFile(gifPath, content);
    await fs.writeFile(arbitraryPath, content);
    const inlineDelivery = new OutboundMediaDelivery({
      rootDir: generatedRoot,
      workspaceRoot
    });

    await expect(inlineDelivery.createReference(emojiPath)).resolves.toBe(
      `base64://${content.toString("base64")}`
    );
    await expect(inlineDelivery.createReference(gifPath)).resolves.toBe(
      `base64://${content.toString("base64")}`
    );
    await expect(inlineDelivery.createReference(arbitraryPath)).rejects.toThrow(
      "content-addressed"
    );
  });

  it("maps sticker segments to NapCat image subtype 1 while keeping normal images untyped", async () => {
    const inlineDelivery = new OutboundMediaDelivery({ rootDir: temporaryDirectory });
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) },
      { outboundMedia: inlineDelivery }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await gateway.send({
      schemaVersion: 1,
      id: "emoji-message",
      conversationId: "group:42",
      accountId: "primary",
      scope: "user_group",
      userId: 7,
      groupId: 42,
      text: "前后",
      media: [
        { schemaVersion: 1, kind: "image", source: "shared_file", filePath: imagePath, url: "/generated-images/generated.png" },
        { schemaVersion: 1, kind: "image", source: "shared_file", filePath: agentImagePath, url: "/generated-images/agents/arona/generated.png" }
      ],
      contentSegments: [
        { type: "text", text: "前" },
        { type: "sticker", imageIndex: 0 },
        { type: "text", text: "后" },
        { type: "image", imageIndex: 1 }
      ],
      replyToMessageId: 5
    });

    const message = sendAction.mock.calls[0]![1].message as Array<{ type: string; data: Record<string, string> }>;
    expect(message.map((segment) => segment.type)).toEqual(["reply", "text", "image", "text", "image"]);
    expect(message[0]?.data.id).toBe("5");
    expect(message[1]?.data.text).toBe("前");
    expect(message[2]?.data.file).toBe(`base64://${Buffer.from("generated-image").toString("base64")}`);
    expect(message[2]?.data.sub_type).toBe(1);
    expect(message[3]?.data.text).toBe("后");
    expect(message[4]?.data.file).toBe(`base64://${Buffer.from("agent-generated-image").toString("base64")}`);
    expect(message[4]?.data).not.toHaveProperty("sub_type");
  });

  it("bounds unique image preparation at two while preserving source order", async () => {
    const inlineDelivery = new OutboundMediaDelivery({ rootDir: temporaryDirectory });
    let active = 0;
    let peak = 0;
    let callIndex = 0;
    const createReference = vi.spyOn(inlineDelivery, "createReference").mockImplementation(async (filePath) => {
      const currentCall = callIndex++;
      active += 1;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, currentCall % 2 === 0 ? 12 : 2));
        return `base64://${Buffer.from(path.basename(filePath)).toString("base64")}`;
      } finally {
        active -= 1;
      }
    });
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) },
      { outboundMedia: inlineDelivery }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });
    const filePaths = Array.from(
      { length: MAX_EMOJI_MARKERS_PER_REPLY },
      (_, index) => emojiFilePath(temporaryDirectory, index + 1)
    );

    await gateway.send({
      schemaVersion: 1,
      id: "bounded-emoji-message",
      conversationId: "group:42",
      accountId: "primary",
      scope: "user_group",
      userId: 7,
      groupId: 42,
      text: "",
      media: filePaths.map((filePath) => ({
        schemaVersion: 1,
        kind: "image",
        source: "shared_file",
        filePath
      })),
      contentSegments: filePaths.map((_, imageIndex) => ({ type: "image", imageIndex }))
    });

    expect(createReference).toHaveBeenCalledTimes(filePaths.length);
    expect(peak).toBe(2);
    const sent = sendAction.mock.calls[0]![1].message as Array<{ type: string; data: Record<string, string> }>;
    expect(sent.map((segment) => segment.data.file)).toEqual(filePaths.map(
      (filePath) => `base64://${Buffer.from(path.basename(filePath)).toString("base64")}`
    ));
  });

  it("reads and encodes each unique emoji path once while retaining repeated marker positions", async () => {
    const inlineDelivery = new OutboundMediaDelivery({ rootDir: temporaryDirectory });
    const createReference = vi.spyOn(inlineDelivery, "createReference").mockImplementation(async (filePath) => (
      `base64://${Buffer.from(path.basename(filePath)).toString("base64")}`
    ));
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) },
      { outboundMedia: inlineDelivery }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });
    const firstPath = emojiFilePath(temporaryDirectory, 10);
    const secondPath = emojiFilePath(temporaryDirectory, 11);

    await gateway.send({
      schemaVersion: 1,
      id: "repeated-emoji-message",
      conversationId: "group:42",
      accountId: "primary",
      scope: "user_group",
      userId: 7,
      groupId: 42,
      text: "甲乙丙丁",
      media: [firstPath, secondPath, firstPath].map((filePath) => ({
        schemaVersion: 1,
        kind: "image",
        source: "shared_file",
        filePath
      })),
      contentSegments: [
        { type: "text", text: "甲" },
        { type: "image", imageIndex: 0 },
        { type: "text", text: "乙" },
        { type: "image", imageIndex: 1 },
        { type: "text", text: "丙" },
        { type: "image", imageIndex: 2 },
        { type: "text", text: "丁" }
      ]
    });

    expect(createReference).toHaveBeenCalledTimes(2);
    expect(createReference.mock.calls.filter(([filePath]) => path.resolve(filePath) === firstPath)).toHaveLength(1);
    const sent = sendAction.mock.calls[0]![1].message as Array<{ type: string; data: Record<string, string> }>;
    expect(sent.map((segment) => segment.type)).toEqual(["text", "image", "text", "image", "text", "image", "text"]);
    expect(sent.filter((segment) => segment.type === "image").map((segment) => segment.data.file)).toEqual([
      `base64://${Buffer.from(path.basename(firstPath)).toString("base64")}`,
      `base64://${Buffer.from(path.basename(secondPath)).toString("base64")}`,
      `base64://${Buffer.from(path.basename(firstPath)).toString("base64")}`
    ]);
  });

  it("rejects an excessive emoji marker count before reading or sending", async () => {
    const inlineDelivery = new OutboundMediaDelivery({ rootDir: temporaryDirectory });
    const createReference = vi.spyOn(inlineDelivery, "createReference");
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) },
      { outboundMedia: inlineDelivery }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });
    const filePath = emojiFilePath(temporaryDirectory, 20);
    expect(MAX_EMOJI_MARKERS_PER_REPLY).toBe(4);
    const markerCount = 5;

    await expect(gateway.send({
      schemaVersion: 1,
      id: "too-many-emoji-markers",
      conversationId: "group:42",
      accountId: "primary",
      scope: "user_group",
      userId: 7,
      groupId: 42,
      text: "",
      media: Array.from({ length: markerCount }, () => ({
        schemaVersion: 1 as const,
        kind: "image" as const,
        source: "shared_file" as const,
        filePath
      })),
      contentSegments: Array.from(
        { length: markerCount },
        (_, imageIndex) => ({ type: "image" as const, imageIndex })
      )
    })).rejects.toThrow(`${MAX_EMOJI_MARKERS_PER_REPLY} emoji markers`);
    expect(createReference).not.toHaveBeenCalled();
    expect(sendAction).not.toHaveBeenCalled();
  });

  it("rejects the aggregate raw bytes of ordinary local inline images before OneBot transport", async () => {
    const inlineDelivery = new OutboundMediaDelivery({ rootDir: temporaryDirectory });
    const rawBytesPerImage = Math.floor(MAX_OUTBOUND_INLINE_EMOJI_BYTES_PER_MESSAGE / 2) + 1;
    const encoded = Buffer.alloc(rawBytesPerImage, 0x61).toString("base64");
    const createReference = vi.spyOn(inlineDelivery, "createReference")
      .mockResolvedValue(`base64://${encoded}`);
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) },
      { outboundMedia: inlineDelivery }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await expect(gateway.send({
      schemaVersion: 1,
      id: "oversized-ordinary-inline-images",
      conversationId: "group:42",
      accountId: "primary",
      scope: "user_group",
      userId: 7,
      groupId: 42,
      text: "",
      media: [imagePath, agentImagePath].map((filePath) => ({
        schemaVersion: 1 as const,
        kind: "image" as const,
        source: "shared_file" as const,
        filePath
      })),
      contentSegments: [
        { type: "image", imageIndex: 0 },
        { type: "image", imageIndex: 1 }
      ]
    })).rejects.toThrow(`${MAX_OUTBOUND_INLINE_EMOJI_BYTES_PER_MESSAGE} bytes`);
    expect(createReference).toHaveBeenCalledTimes(2);
    expect(sendAction).not.toHaveBeenCalled();
  });

  it("rejects the repeated inline emoji byte total before OneBot transport", async () => {
    const inlineDelivery = new OutboundMediaDelivery({ rootDir: temporaryDirectory });
    const repeatedBytes = Math.floor(MAX_OUTBOUND_INLINE_EMOJI_BYTES_PER_MESSAGE / 2) + 1;
    const encoded = Buffer.alloc(repeatedBytes, 0x61).toString("base64");
    const createReference = vi.spyOn(inlineDelivery, "createReference").mockResolvedValue(`base64://${encoded}`);
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) },
      { outboundMedia: inlineDelivery }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });
    const filePath = emojiFilePath(temporaryDirectory, 21);

    await expect(gateway.send({
      schemaVersion: 1,
      id: "oversized-emoji-message",
      conversationId: "group:42",
      accountId: "primary",
      scope: "user_group",
      userId: 7,
      groupId: 42,
      text: "",
      media: [0, 1].map(() => ({
        schemaVersion: 1 as const,
        kind: "image" as const,
        source: "shared_file" as const,
        filePath
      })),
      contentSegments: [
        { type: "image", imageIndex: 0 },
        { type: "image", imageIndex: 1 }
      ]
    })).rejects.toThrow(`${MAX_OUTBOUND_INLINE_EMOJI_BYTES_PER_MESSAGE} bytes`);
    expect(createReference).toHaveBeenCalledOnce();
    expect(sendAction).not.toHaveBeenCalled();
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

  it("revalidates content-addressed emoji bytes immediately before durable delivery", async () => {
    const original = Buffer.from("durable-emoji-a");
    const replacement = Buffer.from("durable-emoji-b");
    expect(replacement).toHaveLength(original.length);
    const fileName = `emoji-${crypto.createHash("sha256").update(original).digest("hex")}.png`;
    const filePath = path.join(temporaryDirectory, "agents", "arona", fileName);
    await fs.writeFile(filePath, original);
    const inlineDelivery = new OutboundMediaDelivery({ rootDir: temporaryDirectory });

    await expect(inlineDelivery.createReference(filePath)).resolves.toBe(
      `base64://${original.toString("base64")}`
    );

    await fs.writeFile(filePath, replacement);
    await expect(inlineDelivery.createReference(filePath)).rejects.toThrow(
      "does not match its content-addressed file name"
    );
  });
});

function emojiFilePath(rootDir: string, value: number) {
  const digest = value.toString(16).padStart(64, "0");
  return path.join(rootDir, "agents", "arona", `emoji-${digest}.png`);
}
