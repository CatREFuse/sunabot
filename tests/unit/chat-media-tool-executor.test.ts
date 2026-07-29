// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { ProviderCompleteOptions } from "../../adapters/model/provider/contracts.js";

describe("chat media Provider tool boundary", () => {
  it("declares export without the administrator-only emoji mutation", () => {
    const executor = new RegistryProviderToolExecutor();
    const options: ProviderCompleteOptions = {
      chatMedia: {
        export: vi.fn()
      }
    };

    expect(executor.resolveDefinitions(options).map((definition) => definition.name))
      .toEqual(["export_chat_media"]);
  });

  it("executes an exact declared export and rejects a forged emoji import before the port", async () => {
    const exportMedia = vi.fn(async () => ({
      ok: true as const,
      path: "chat-media-a.png",
      sha256: "a".repeat(64),
      mimeType: "image/png",
      extension: "png",
      byteLength: 10,
      width: 1,
      height: 1,
      deduplicated: false
    }));
    const importEmoji = vi.fn();
    const options: ProviderCompleteOptions = {
      chatMedia: {
        export: exportMedia
      }
    };
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options);
    const [exported] = await executor.execute([{
      type: "function_call",
      name: "export_chat_media",
      call_id: "export-1",
      arguments: JSON.stringify({ handle: "message:77:image:0" })
    }], options, definitions);
    const [forged] = await executor.execute([{
      type: "function_call",
      name: "import_chat_emoji",
      call_id: "import-1",
      arguments: JSON.stringify({
        handle: "message:77:image:0",
        key: "开心"
      })
    }], {
      chatMedia: {
        export: exportMedia,
        importEmoji
      }
    }, definitions);

    expect(JSON.parse(String(exported?.output))).toMatchObject({
      ok: true,
      path: "chat-media-a.png"
    });
    expect(exportMedia).toHaveBeenCalledWith({ handle: "message:77:image:0" });
    expect(JSON.parse(String(forged?.output))).toEqual({
      ok: false,
      error: "Tool import_chat_emoji is not enabled for this prompt."
    });
    expect(importEmoji).not.toHaveBeenCalled();
  });

  it("allows emoji, selfie and media export in the same batch", async () => {
    const exportMedia = vi.fn(async () => ({ ok: true, path: "chat-media-a.png" }));
    const importEmoji = vi.fn(async () => ({ ok: true, key: "开心" }));
    const importSelfie = vi.fn(async () => ({ ok: true, id: "a".repeat(64) }));
    const options: ProviderCompleteOptions = {
      chatMedia: {
        export: exportMedia,
        importEmoji,
        importSelfie
      }
    };
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options);
    const outputs = await executor.execute([{
      type: "function_call",
      name: "import_chat_emoji",
      call_id: "import-2",
      arguments: JSON.stringify({
        handle: "message:77:image:0",
        key: "开心"
      })
    }, {
      type: "function_call",
      name: "import_chat_selfie",
      call_id: "import-selfie-2",
      arguments: JSON.stringify({
        handle: "message:77:image:0",
        note: "正面常服"
      })
    }, {
      type: "function_call",
      name: "export_chat_media",
      call_id: "export-2",
      arguments: JSON.stringify({ handle: "message:77:image:0" })
    }], options, definitions);

    expect(outputs.map((output) => JSON.parse(String(output.output))))
      .toEqual([
        { ok: true, key: "开心" },
        { ok: true, id: "a".repeat(64) },
        { ok: true, path: "chat-media-a.png" }
      ]);
    expect(exportMedia).toHaveBeenCalledOnce();
    expect(importEmoji).toHaveBeenCalledOnce();
    expect(importSelfie).toHaveBeenCalledWith({
      handle: "message:77:image:0",
      note: "正面常服"
    });
  });
});
