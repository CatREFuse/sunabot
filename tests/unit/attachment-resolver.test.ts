// @vitest-environment node
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractOneBotAttachmentSource,
  resolveOneBotAttachment
} from "../../adapters/onebot/queryAdapter.js";
import { AttachmentResolutionError } from "../../packages/contracts/media/media.js";
import { FakeAttachmentSourcePort } from "../../packages/testkit/fakeMessagingPort.js";
import { resolveAttachmentSource } from "../../services/media/attachments/resolver.js";

describe("attachment source resolver", () => {
  it("uses a message HTTP URL without consulting the adapter", async () => {
    const port = new FakeAttachmentSourcePort(new Error("must not be called"));
    const url = "https://cdn.example.test/file?id=1&token=signed";

    await expect(resolveAttachmentSource({ url, fileId: "file-1" }, port))
      .resolves.toEqual({ kind: "url", url, via: "message_url" });
    expect(port.resolveCalls).toEqual([]);
  });

  it("maps a group file request at the OneBot adapter boundary", async () => {
    const sendAction = vi.fn(async () => ({ data: { url: "https://cdn.example.test/group-file" } }));
    await expect(resolveOneBotAttachment({ sendAction }, {
      groupId: 123,
      fileId: "group-file-id",
      busId: 456
    })).resolves.toEqual({
      kind: "url",
      url: "https://cdn.example.test/group-file",
      via: "group_file_url"
    });
    expect(sendAction).toHaveBeenCalledWith("get_group_file_url", {
      group_id: 123,
      file_id: "group-file-id",
      busid: 456
    });
  });

  it("falls back from URL lookup to file content", async () => {
    const sendAction = vi.fn(async (action: string) => {
      if (action === "get_group_file_url") throw new Error("not available");
      return { data: { base64: "aGVsbG8=" } };
    });
    await expect(resolveOneBotAttachment({ sendAction }, { groupId: 123, fileId: "file-1" }))
      .resolves.toEqual({ kind: "base64", base64: "aGVsbG8=", via: "file_content" });
    expect(sendAction.mock.calls).toEqual([
      ["get_group_file_url", { group_id: 123, file_id: "file-1" }],
      ["get_file", { file_id: "file-1" }]
    ]);
  });

  it("accepts only shared local paths allowed by the caller", async () => {
    const sharedRoot = path.resolve("/shared/napcat");
    const sendAction = vi.fn(async () => ({
      data: { file: path.join(sharedRoot, "downloads", "report.pdf") }
    }));
    await expect(resolveOneBotAttachment({ sendAction }, { file: "report.pdf" }, {
      sharedRoots: [sharedRoot]
    })).resolves.toEqual({
      kind: "shared_path",
      filePath: path.join(sharedRoot, "downloads", "report.pdf"),
      via: "file_content"
    });
  });

  it("recognizes supported response shapes without exposing them to services", () => {
    expect(extractOneBotAttachmentSource({ data: "base64://aGVsbG8=" }))
      .toEqual({ kind: "base64", base64: "aGVsbG8=" });
    expect(extractOneBotAttachmentSource({ data: { url: "ftp://example.test/file" } }))
      .toBeUndefined();
    expect(extractOneBotAttachmentSource({ data: { path: "/shared/../private/file" } }, {
      sharedRoots: ["/shared"]
    })).toBeUndefined();
  });

  it("reports exhausted domain strategies without leaking upstream errors", async () => {
    const sendAction = vi.fn(async (action: string) => {
      if (action === "get_private_file_url") return { data: {} };
      throw new Error("secret upstream detail");
    });
    const error = await resolveOneBotAttachment({ sendAction }, { fileId: "file-1" })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AttachmentResolutionError);
    expect(error).toMatchObject({ attempts: [
      { strategy: "private_file_url", outcome: "empty" },
      { strategy: "file_content", outcome: "error" }
    ] });
    expect(String(error)).not.toContain("secret upstream detail");
  });
});
