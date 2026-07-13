// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveLocalInputImage,
  toResponsesInputMessage
} from "../../adapters/model/openaiProvider.js";

const cacheRoot = path.join(process.cwd(), "workspace/cache/attachments");
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((value) => rm(value, {
    recursive: true,
    force: true
  })));
});

describe("attachment provider images", () => {
  it("marks only non-assistant text blocks as explicit prompt cache breakpoints", async () => {
    const developer = await toResponsesInputMessage({
      role: "developer",
      content: "稳定系统提示词"
    }, { promptCacheBreakpoint: true });
    const assistant = await toResponsesInputMessage({
      role: "assistant",
      content: "历史回复"
    }, { promptCacheBreakpoint: true });

    expect(developer.content[0]).toEqual({
      type: "input_text",
      text: "稳定系统提示词",
      prompt_cache_breakpoint: { mode: "explicit" }
    });
    expect(assistant.content[0]).toEqual({ type: "output_text", text: "历史回复" });
  });

  it("converts a cache-contained local image to a bounded data URL", async () => {
    await mkdir(cacheRoot, { recursive: true });
    const directory = await mkdtemp(path.join(cacheRoot, "provider-test-"));
    cleanupPaths.push(directory);
    const filePath = path.join(directory, "page.png");
    await sharp({
      create: { width: 200, height: 100, channels: 3, background: "white" }
    }).png().toFile(filePath);

    const result = await resolveLocalInputImage(filePath);

    expect(result).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.from(result!.split(",")[1]!, "base64").length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("rejects files outside the attachment cache and symlink escapes", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "sunabot-provider-outside-"));
    cleanupPaths.push(outside);
    const outsideFile = path.join(outside, "secret.png");
    await sharp({
      create: { width: 10, height: 10, channels: 3, background: "black" }
    }).png().toFile(outsideFile);
    await mkdir(cacheRoot, { recursive: true });
    const inside = await mkdtemp(path.join(cacheRoot, "provider-link-test-"));
    cleanupPaths.push(inside);
    const linkPath = path.join(inside, "escape.png");
    await symlink(outsideFile, linkPath);

    await expect(resolveLocalInputImage(outsideFile)).resolves.toBeNull();
    await expect(resolveLocalInputImage(linkPath)).resolves.toBeNull();
  });

  it("keeps ordinary remote image inputs while adding local attachment images", async () => {
    await mkdir(cacheRoot, { recursive: true });
    const directory = await mkdtemp(path.join(cacheRoot, "provider-message-test-"));
    cleanupPaths.push(directory);
    const filePath = path.join(directory, "local.png");
    await sharp({
      create: { width: 20, height: 20, channels: 3, background: "red" }
    }).png().toFile(filePath);
    const remote = "data:image/png;base64,iVBORw0KGgo=";

    const result = await toResponsesInputMessage({
      role: "user",
      content: "查看图片",
      imageUrls: [remote],
      localImagePaths: [filePath]
    });

    expect(result.content).toHaveLength(3);
    expect(result.content[1]).toEqual({ type: "input_image", image_url: remote });
    expect(result.content[2]).toEqual(expect.objectContaining({
      type: "input_image",
      image_url: expect.stringMatching(/^data:image\/jpeg;base64,/)
    }));
  });
});
