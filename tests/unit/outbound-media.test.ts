// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutboundMediaDelivery } from "../../src/outboundMedia.js";

describe("OutboundMediaDelivery", () => {
  const secret = Buffer.alloc(32, 7);
  let nowSeconds = 1_788_000_000;
  let rootDir = "";
  let imagePath = "";
  let delivery: OutboundMediaDelivery;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-outbound-media-"));
    imagePath = path.join(rootDir, "generated-image.png");
    await fs.writeFile(imagePath, Buffer.from("png-fixture"));
    delivery = new OutboundMediaDelivery({
      rootDir,
      secret,
      ttlSeconds: 300,
      nowSeconds: () => nowSeconds
    });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("signs and resolves one generated image without protocol-specific data", async () => {
    const signedPath = await delivery.createSignedPath(imagePath);
    const url = new URL(signedPath, "http://sunabot.invalid");
    const resolved = await delivery.resolveSignedPath(
      decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
      url.searchParams.get("expires"),
      url.searchParams.get("signature")
    );

    expect(url.pathname).toBe("/outbound-media/generated-images/generated-image.png");
    expect(url.searchParams.get("expires")).toBe(String(nowSeconds + 300));
    expect(url.searchParams.get("signature")).toMatch(/^[a-f0-9]{64}$/);
    expect(resolved).toEqual({
      filePath: imagePath,
      size: Buffer.byteLength("png-fixture"),
      contentType: "image/png"
    });
    expect(signedPath).not.toContain("onebot");
    expect(signedPath).not.toContain("napcat");
    expect(signedPath).not.toContain("docker");
  });

  it("rejects tampered names, expiry values and signatures", async () => {
    const url = new URL(await delivery.createSignedPath(imagePath), "http://sunabot.invalid");
    const expires = url.searchParams.get("expires");
    const signature = url.searchParams.get("signature");

    await expect(delivery.resolveSignedPath("other.png", expires, signature)).resolves.toBeNull();
    await expect(delivery.resolveSignedPath("generated-image.png", String(nowSeconds + 120), signature)).resolves.toBeNull();
    await expect(delivery.resolveSignedPath("generated-image.png", expires, "0".repeat(64))).resolves.toBeNull();
  });

  it("rejects expired signatures and signed expiry values beyond the configured window", async () => {
    const url = new URL(await delivery.createSignedPath(imagePath), "http://sunabot.invalid");
    nowSeconds += 301;
    await expect(delivery.resolveSignedPath(
      "generated-image.png",
      url.searchParams.get("expires"),
      url.searchParams.get("signature")
    )).resolves.toBeNull();

    nowSeconds -= 301;
    const excessiveExpiry = nowSeconds + 301;
    const excessiveSignature = sign("generated-image.png", excessiveExpiry, secret);
    await expect(delivery.resolveSignedPath(
      "generated-image.png",
      String(excessiveExpiry),
      excessiveSignature
    )).resolves.toBeNull();
  });

  it("rejects traversal, nested, non-PNG, missing and symlink assets", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-outbound-media-outside-"));
    const outsideImage = path.join(outsideDir, "outside.png");
    const textFile = path.join(rootDir, "note.txt");
    const nestedDir = path.join(rootDir, "nested");
    const nestedImage = path.join(nestedDir, "nested.png");
    const symlinkPath = path.join(rootDir, "linked.png");
    await fs.writeFile(outsideImage, Buffer.from("outside"));
    await fs.writeFile(textFile, Buffer.from("text"));
    await fs.mkdir(nestedDir);
    await fs.writeFile(nestedImage, Buffer.from("nested"));
    await fs.symlink(outsideImage, symlinkPath);

    try {
      await expect(delivery.createSignedPath(outsideImage)).rejects.toThrow("outside the outbound media root");
      await expect(delivery.createSignedPath(textFile)).rejects.toThrow("PNG");
      await expect(delivery.createSignedPath(nestedImage)).rejects.toThrow("direct child");
      await expect(delivery.createSignedPath(path.join(rootDir, "missing.png"))).rejects.toThrow("not a regular file");
      await expect(delivery.createSignedPath(symlinkPath)).rejects.toThrow("not a regular file");
      await expect(delivery.resolveSignedPath("../outside.png", "1", "0".repeat(64))).resolves.toBeNull();
      await expect(delivery.resolveSignedPath("nested/nested.png", "1", "0".repeat(64))).resolves.toBeNull();
      await expect(delivery.resolveSignedPath("note.txt", "1", "0".repeat(64))).resolves.toBeNull();
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

function sign(fileName: string, expires: number, secret: Buffer) {
  return crypto.createHmac("sha256", secret)
    .update(`${fileName}\n${expires}`, "utf8")
    .digest("hex");
}
