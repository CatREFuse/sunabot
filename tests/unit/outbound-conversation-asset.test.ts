// @vitest-environment node
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OneBotGateway } from "../../adapters/onebot/onebotGateway.js";
import {
  captureOutboundConversationAssetRootIdentity,
  DEFAULT_OUTBOUND_CONVERSATION_ASSET_MAX_INLINE_BYTES,
  normalizeOutboundConversationAssetError,
  OutboundConversationAssetDelivery
} from "../../services/delivery/outboundConversationAsset.js";
import { defaultConfig } from "../../src/config.js";

describe("outbound conversation assets", () => {
  let rootDir = "";
  let outsideDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-outbound-asset-"));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-outbound-outside-"));
    await fs.mkdir(path.join(rootDir, "exports"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "exports", "report.txt"), "report");
    await fs.writeFile(path.join(rootDir, "exports", "pixel.png"), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    ));
    await fs.writeFile(path.join(rootDir, "exports", "voice.amr"), Buffer.from("#!AMR\nvoice"));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret");
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(rootDir, { recursive: true, force: true }),
      fs.rm(outsideDir, { recursive: true, force: true })
    ]);
  });

  it("prepares bounded inline file, image, and voice sources from relative paths", async () => {
    const delivery = createDelivery(rootDir);

    await expect(delivery.prepare({ path: "exports/report.txt", kind: "auto" })).resolves.toMatchObject({
      kind: "file",
      name: "report.txt",
      byteLength: 6,
      sha256: "845e91831319e89c4d656bdb80c278ac09a7230d61e5dfd2e1b1fbb436ac8917",
      source: `base64://${Buffer.from("report").toString("base64")}`
    });
    await expect(delivery.prepare({ path: "exports/pixel.png", kind: "auto", name: "结果图.png" })).resolves.toMatchObject({
      kind: "image",
      name: "结果图.png",
      mimeType: "image/png"
    });
    await expect(delivery.prepare({ path: "exports/voice.amr", kind: "voice" })).resolves.toMatchObject({
      kind: "voice",
      name: "voice.amr"
    });
  });

  it("rejects absolute paths, traversal, symlinks, type mismatches, and oversized files", async () => {
    await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(rootDir, "linked.txt"));
    await fs.symlink(outsideDir, path.join(rootDir, "linked-directory"));
    const delivery = createDelivery(rootDir, { maxInlineBytes: 8 });

    await expect(delivery.prepare({ path: path.join(rootDir, "exports/report.txt"), kind: "file" }))
      .rejects.toThrow("relative");
    await expect(delivery.prepare({ path: "C:\\secrets\\report.txt", kind: "file" }))
      .rejects.toThrow("invalid");
    await expect(delivery.prepare({ path: "exports\\report.txt", kind: "file" }))
      .rejects.toThrow("invalid");
    await expect(delivery.prepare({ path: "../secret.txt", kind: "file" }))
      .rejects.toThrow("traversal");
    await expect(delivery.prepare({ path: "exports/../exports/report.txt", kind: "file" }))
      .rejects.toThrow("traversal");
    await expect(delivery.prepare({ path: "linked.txt", kind: "file" }))
      .rejects.toThrow("symbolic links");
    await expect(delivery.prepare({ path: "linked-directory/secret.txt", kind: "file" }))
      .rejects.toThrow("symbolic links");
    await expect(delivery.prepare({ path: "exports/report.txt", kind: "image" }))
      .rejects.toThrow("recognized image");
    await expect(delivery.prepare({ path: "exports/report.txt", kind: "file", name: "../report.txt" }))
      .rejects.toThrow("name is invalid");
    await expect(delivery.prepare({ path: "exports/pixel.png", kind: "image" }))
      .rejects.toThrow("exceeds the inline Base64 limit of 8 bytes");
  });

  it("rejects a file that changed after the tool queued it", async () => {
    const delivery = createDelivery(rootDir);
    const input = { path: "exports/report.txt", kind: "file" as const };
    const original = await delivery.prepare(input);
    await fs.writeFile(path.join(rootDir, input.path), "changed");

    await expect(delivery.prepare(input, {
      byteLength: original.byteLength,
      sha256: original.sha256 ?? ""
    })).rejects.toThrow("changed after it was queued");
  });

  it("rejects queued content replaced by a different type or symbolic link", async () => {
    const delivery = createDelivery(rootDir);
    const imageInput = { path: "exports/pixel.png", kind: "image" as const };
    const originalImage = await delivery.prepare(imageInput);
    await fs.writeFile(path.join(rootDir, imageInput.path), "plain text now");
    await expect(delivery.prepare(imageInput, {
      byteLength: originalImage.byteLength,
      sha256: originalImage.sha256 ?? ""
    })).rejects.toThrow("recognized image");

    const fileInput = { path: "exports/report.txt", kind: "file" as const };
    const originalFile = await delivery.prepare(fileInput);
    await fs.rm(path.join(rootDir, fileInput.path));
    await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(rootDir, fileInput.path));
    await expect(delivery.prepare(fileInput, {
      byteLength: originalFile.byteLength,
      sha256: originalFile.sha256 ?? ""
    })).rejects.toThrow("symbolic links");
  });

  it("does not follow a leaf symlink swapped in after path validation", async () => {
    const target = path.join(rootDir, "exports", "report.txt");
    const outside = path.join(outsideDir, "secret.txt");
    let swapped = false;
    const delivery = createDelivery(rootDir, {
      openFile: async (filePath, flags) => {
        if (!swapped) {
          swapped = true;
          await fs.rm(target);
          await fs.symlink(outside, target);
        }
        return fs.open(filePath, flags);
      }
    });

    await expect(delivery.prepare({ path: "exports/report.txt", kind: "file" }))
      .rejects.toThrow(/symbolic links/);
  });

  it("rejects an intermediate directory swapped to a symlink before descriptor open", async () => {
    const exportsDir = path.join(rootDir, "exports");
    const originalDir = path.join(rootDir, "exports-original");
    await fs.writeFile(path.join(outsideDir, "report.txt"), "outside secret");
    let swapped = false;
    const delivery = createDelivery(rootDir, {
      openFile: async (filePath, flags) => {
        if (!swapped) {
          swapped = true;
          await fs.rename(exportsDir, originalDir);
          await fs.symlink(outsideDir, exportsDir);
        }
        return fs.open(filePath, flags);
      }
    });

    await expect(delivery.prepare({ path: "exports/report.txt", kind: "file" }))
      .rejects.toThrow(/symbolic links|path changed|SEND_FILE_ROOT_CHANGED/);
  });

  it("rejects hard links and non-regular files", async () => {
    await fs.link(
      path.join(rootDir, "exports", "report.txt"),
      path.join(rootDir, "exports", "report-hardlink.txt")
    );
    const delivery = createDelivery(rootDir);

    await expect(delivery.prepare({ path: "exports/report-hardlink.txt", kind: "file" }))
      .rejects.toThrow("hard link");
    await expect(delivery.prepare({ path: "exports", kind: "file" }))
      .rejects.toThrow("not a regular file");
  });

  it("rejects a workbench root that is a symlink when delivery is constructed", async () => {
    const rootIdentity = captureOutboundConversationAssetRootIdentity(rootDir);
    const originalRoot = `${rootDir}-original`;
    await fs.rename(rootDir, originalRoot);
    await fs.symlink(outsideDir, rootDir);
    try {
      expect(() => new OutboundConversationAssetDelivery({ rootDir, rootIdentity }))
        .toThrow("SEND_FILE_ROOT_CHANGED");
    } finally {
      await fs.rm(rootDir, { force: true });
      await fs.rename(originalRoot, rootDir);
    }
  });

  it("rejects a root replaced by an outside symlink before prepare without opening outside content", async () => {
    const rootIdentity = captureOutboundConversationAssetRootIdentity(rootDir);
    const originalRoot = `${rootDir}-original`;
    const openFile = vi.fn(fs.open);
    const delivery = new OutboundConversationAssetDelivery({ rootDir, rootIdentity, openFile });
    await fs.mkdir(path.join(outsideDir, "exports"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "exports", "report.txt"), "outside-secret");
    await fs.rename(rootDir, originalRoot);
    await fs.symlink(outsideDir, rootDir);
    try {
      await expect(delivery.prepare({ path: "exports/report.txt", kind: "file" }))
        .rejects.toThrow("SEND_FILE_ROOT_CHANGED");
      expect(openFile).not.toHaveBeenCalled();
    } finally {
      await fs.rm(rootDir, { force: true });
      await fs.rename(originalRoot, rootDir);
    }
  });

  it("rejects a root swapped to outside and restored during descriptor open before reading", async () => {
    const originalRoot = `${rootDir}-original`;
    await fs.mkdir(path.join(outsideDir, "exports"), { recursive: true });
    await fs.writeFile(path.join(outsideDir, "exports", "report.txt"), "outside-secret");
    let read: ReturnType<typeof vi.fn> | undefined;
    const delivery = createDelivery(rootDir, {
      openFile: async (filePath, flags) => {
        await fs.rename(rootDir, originalRoot);
        await fs.symlink(outsideDir, rootDir);
        try {
          const handle = await fs.open(filePath, flags);
          read = vi.spyOn(handle, "read");
          return handle;
        } finally {
          await fs.rm(rootDir, { force: true });
          await fs.rename(originalRoot, rootDir);
        }
      }
    });

    await expect(delivery.prepare({ path: "exports/report.txt", kind: "file" }))
      .rejects.toThrow("SEND_FILE_ROOT_CHANGED");
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects a root swapped away and restored while the descriptor is being read", async () => {
    const originalRoot = `${rootDir}-original`;
    let swapped = false;
    const delivery = createDelivery(rootDir, {
      openFile: async (filePath, flags) => {
        const handle = await fs.open(filePath, flags);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...args) => {
          swapped = true;
          await fs.rename(rootDir, originalRoot);
          await fs.symlink(outsideDir, rootDir);
          try {
            return await read(...args);
          } finally {
            await fs.rm(rootDir, { force: true });
            await fs.rename(originalRoot, rootDir);
          }
        });
        return handle;
      }
    });

    await expect(delivery.prepare({ path: "exports/report.txt", kind: "file" }))
      .rejects.toThrow("SEND_FILE_ROOT_CHANGED");
    expect(swapped).toBe(true);
  });

  it("rejects a root replaced by a different regular directory identity", async () => {
    const originalRoot = `${rootDir}-original`;
    const delivery = createDelivery(rootDir);
    await fs.rename(rootDir, originalRoot);
    await fs.mkdir(rootDir);
    try {
      await expect(delivery.prepare({ path: "exports/report.txt", kind: "file" }))
        .rejects.toThrow("SEND_FILE_ROOT_CHANGED");
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
      await fs.rename(originalRoot, rootDir);
    }
  });

  it("normalizes missing and permission-denied filesystem errors without absolute paths", async () => {
    const missingPath = path.join(rootDir, "exports", "missing.txt");
    const missingDelivery = createDelivery(rootDir);
    const missingError = await missingDelivery.prepare({ path: "exports/missing.txt", kind: "file" })
      .catch((error: unknown) => error as Error & { code?: string });
    expect(missingError).toMatchObject({ code: "SEND_FILE_SOURCE_MISSING" });
    expect(missingError.message).not.toContain(rootDir);
    expect(missingError.message).not.toContain(missingPath);

    const deniedDelivery = createDelivery(rootDir, {
      openFile: async () => {
        throw Object.assign(new Error(`EACCES: permission denied, open '${missingPath}'`), { code: "EACCES" });
      }
    });
    const deniedError = await deniedDelivery.prepare({ path: "exports/report.txt", kind: "file" })
      .catch((error: unknown) => error as Error & { code?: string });
    expect(deniedError).toMatchObject({ code: "SEND_FILE_SOURCE_FORBIDDEN" });
    expect(deniedError.message).not.toContain(rootDir);
    expect(deniedError.message).not.toContain(missingPath);
  });

  it("normalizes code-only and message-only filesystem failures without leaking paths", () => {
    const hostPath = path.join(rootDir, "exports", "secret.txt");
    const cases = [
      { code: "EIO" },
      { code: "ERR_FS_FILE_TOO_LARGE" },
      { syscall: "read", path: hostPath },
      new Error(`EIO: input/output failure at '${hostPath}'`),
      new Error(`read failed at '${hostPath}'`),
      new Error("read failed at '\\\\host\\share\\secret.txt'"),
      new Error("read failed at '/资料/私密.txt'")
    ];
    for (const failure of cases) {
      const normalized = normalizeOutboundConversationAssetError(failure) as Error & { code?: string };
      expect(normalized).toMatchObject({ code: "SEND_FILE_SOURCE_UNAVAILABLE" });
      expect(normalized.message).not.toContain(rootDir);
      expect(normalized.message).not.toContain(hostPath);
    }
  });

  it.each(["read", "close"] as const)("normalizes FileHandle $0 errors without leaking paths", async (stage) => {
    const hostPath = path.join(rootDir, "exports", "report.txt");
    const delivery = createDelivery(rootDir, {
      openFile: async (filePath, flags) => {
        const handle = await fs.open(filePath, flags);
        if (stage === "read") {
          vi.spyOn(handle, "read").mockRejectedValue(Object.assign(
            new Error(`EIO: read failed at '${hostPath}'`),
            { code: "EIO" }
          ));
        } else {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            await close();
            throw Object.assign(new Error(`EIO: close failed at '${hostPath}'`), { code: "EIO" });
          });
        }
        return handle;
      }
    });

    const error = await delivery.prepare({ path: "exports/report.txt", kind: "file" })
      .catch((caught: unknown) => caught as Error & { code?: string });
    expect(error).toMatchObject({ code: "SEND_FILE_SOURCE_UNAVAILABLE" });
    expect(error.message).not.toContain(rootDir);
    expect(error.message).not.toContain(hostPath);
  });

  it("keeps concurrent file growth bounded before Base64 or remote delivery", async () => {
    const target = path.join(rootDir, "exports", "report.txt");
    const requestedBufferSizes: number[] = [];
    let appended = false;
    const delivery = createDelivery(rootDir, {
      maxInlineBytes: 8,
      openFile: async (filePath, flags) => {
        const handle = await fs.open(filePath, flags);
        const read = handle.read.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...args) => {
          const buffer = args[0] as Buffer;
          requestedBufferSizes.push(buffer.byteLength);
          if (!appended) {
            appended = true;
            await fs.appendFile(target, Buffer.alloc(64, 0x61));
          }
          return read(...args);
        });
        return handle;
      }
    });
    const sendRemote = vi.fn(async () => undefined);
    const base64Calls: unknown[][] = [];
    const toString = Buffer.prototype.toString;
    const toStringSpy = vi.spyOn(Buffer.prototype, "toString").mockImplementation(function (...args) {
      if (args[0] === "base64") base64Calls.push(args);
      return toString.apply(this, args as Parameters<typeof toString>);
    });
    try {
      await expect(delivery.prepare({ path: "exports/report.txt", kind: "file" }).then(sendRemote))
        .rejects.toThrow(/inline Base64 limit|changed while it was being read/);
      expect(Math.max(...requestedBufferSizes)).toBeLessThanOrEqual(6);
      expect(requestedBufferSizes).toEqual(expect.arrayContaining([6, 1]));
      expect(base64Calls).toEqual([]);
      expect(sendRemote).not.toHaveBeenCalled();
    } finally {
      toStringSpy.mockRestore();
    }
  });

  it("maps image, file, and voice assets to targeted OneBot actions", async () => {
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({
      status: "ok",
      data: { message_id: 88 }
    });

    await gateway.sendConversationAsset({
      accountId: "account-b",
      scope: "user_group",
      userId: 99,
      groupId: 42,
      asset: { kind: "image", name: "image.png", source: "base64://aW1hZ2U=", byteLength: 5 }
    });
    await gateway.sendConversationAsset({
      accountId: "account-b",
      scope: "private",
      userId: 99,
      asset: { kind: "file", name: "报告.txt", source: "base64://cmVwb3J0", byteLength: 6 }
    });
    await gateway.sendConversationAsset({
      accountId: "account-b",
      scope: "user_group",
      userId: 99,
      groupId: 42,
      asset: { kind: "voice", name: "voice.amr", source: "base64://dm9pY2U=", byteLength: 5 }
    });

    expect(sendAction).toHaveBeenNthCalledWith(1, "send_group_msg", {
      group_id: 42,
      message: [{ type: "image", data: { file: "base64://aW1hZ2U=" } }]
    }, "account-b");
    expect(sendAction).toHaveBeenNthCalledWith(2, "upload_private_file", {
      user_id: 99,
      file: "base64://cmVwb3J0",
      name: "报告.txt"
    }, "account-b");
    expect(sendAction).toHaveBeenNthCalledWith(3, "send_group_msg", {
      group_id: 42,
      message: [{ type: "record", data: { file: "base64://dm9pY2U=" } }]
    }, "account-b");
  });

  it("uses upload_group_file for ordinary group files and rejects invalid targets", async () => {
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await gateway.sendConversationAsset({
      accountId: "primary",
      scope: "user_group",
      userId: 99,
      groupId: 42,
      asset: { kind: "file", name: "report.pdf", source: "base64://cGRm", byteLength: 3 }
    });
    await expect(gateway.sendConversationAsset({
      accountId: "primary",
      scope: "user_group",
      userId: 99,
      asset: { kind: "file", name: "report.pdf", source: "base64://cGRm", byteLength: 3 }
    })).rejects.toThrow("groupId");
    await expect(gateway.sendConversationAsset({
      accountId: "primary",
      scope: "private",
      userId: 99,
      asset: { kind: "file", name: "secret.txt", source: "/tmp/secret.txt", byteLength: 6 }
    })).rejects.toThrow("inline Base64");
    await expect(gateway.sendConversationAsset({
      accountId: "primary",
      scope: "private",
      userId: 99,
      asset: { kind: "file", name: "secret.txt", source: "base64://c2VjcmV0", byteLength: 5 }
    })).rejects.toThrow("inline Base64");
    await expect(gateway.sendConversationAsset({
      scope: "private",
      userId: 99,
      asset: { kind: "file", name: "report.pdf", source: "base64://cGRm", byteLength: 3 }
    })).rejects.toThrow("explicit accountId");

    expect(sendAction).toHaveBeenCalledWith("upload_group_file", {
      group_id: 42,
      file: "base64://cGRm",
      name: "report.pdf"
    }, "primary");
  });

  it("validates canonical Base64 linearly from empty through the 32 MiB boundary", async () => {
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) }
    );
    const sendAction = vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    for (const byteLength of [
      0,
      1024 * 1024,
      DEFAULT_OUTBOUND_CONVERSATION_ASSET_MAX_INLINE_BYTES - 1,
      DEFAULT_OUTBOUND_CONVERSATION_ASSET_MAX_INLINE_BYTES
    ]) {
      const source = `base64://${Buffer.alloc(byteLength, 0xa5).toString("base64")}`;
      const decodeSpy = vi.spyOn(Buffer, "from");
      try {
        await expect(gateway.sendConversationAsset({
          accountId: "primary",
          scope: "private",
          userId: 99,
          asset: { kind: "file", name: "boundary.bin", source, byteLength }
        })).resolves.toMatchObject({ accepted: true });
        expect(decodeSpy).not.toHaveBeenCalled();
      } finally {
        decodeSpy.mockRestore();
      }
      sendAction.mockClear();
    }
  }, 30_000);

  it("rejects oversized metadata and sources before decode with a bounded error", async () => {
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) }
    );
    vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });
    const limit = DEFAULT_OUTBOUND_CONVERSATION_ASSET_MAX_INLINE_BYTES;
    const maxEncodedLength = Math.ceil(limit / 3) * 4;

    await expect(gateway.sendConversationAsset({
      accountId: "primary",
      scope: "private",
      userId: 99,
      asset: { kind: "file", name: "too-large.bin", source: "base64://", byteLength: limit + 1 }
    })).rejects.toThrow(`inline Base64 limit of ${limit} bytes`);
    await expect(gateway.sendConversationAsset({
      accountId: "primary",
      scope: "private",
      userId: 99,
      asset: {
        kind: "file",
        name: "too-large.bin",
        source: `base64://${"A".repeat(maxEncodedLength + 4)}`,
        byteLength: limit
      }
    })).rejects.toThrow(`inline Base64 limit of ${limit} bytes`);
  });

  it.each([
    { source: "base64://A", byteLength: 1 },
    { source: "base64://!!!!", byteLength: 3 },
    { source: "base64://Zg=A", byteLength: 1 },
    { source: "base64://Zg=", byteLength: 1 },
    { source: "base64://Zh==", byteLength: 1 },
    { source: "base64://Zm9=", byteLength: 2 }
  ])("rejects invalid Base64 characters, length, padding, and padding bits", async ({ source, byteLength }) => {
    const gateway = new OneBotGateway(
      http.createServer(),
      defaultConfig(),
      { handleInboundMessage: vi.fn(async () => undefined) }
    );
    vi.spyOn(gateway, "sendAction").mockResolvedValue({ status: "ok" });

    await expect(gateway.sendConversationAsset({
      accountId: "primary",
      scope: "private",
      userId: 99,
      asset: { kind: "file", name: "invalid.bin", source, byteLength }
    })).rejects.toThrow("bounded inline Base64 data");
  });
});

function createDelivery(
  rootDir: string,
  options: Partial<Omit<ConstructorParameters<typeof OutboundConversationAssetDelivery>[0], "rootDir" | "rootIdentity">> = {}
) {
  return new OutboundConversationAssetDelivery({
    rootDir,
    rootIdentity: captureOutboundConversationAssetRootIdentity(rootDir),
    ...options
  });
}
