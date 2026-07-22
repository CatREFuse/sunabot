// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import { normalizeOutboundConversationAssetError } from "../../services/delivery/public.js";
import {
  createSendVoiceMessageTool,
  readSendFileInput,
  readSendVoiceMessageInput,
  sendFileTool,
  sendVoiceMessageTool
} from "../../services/tools/sendConversationAssetTool.js";

const appendRequestLog = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../adapters/observability/requestLog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/observability/requestLog.js")>()),
  appendRequestLog
}));

describe("conversation asset tool definitions", () => {
  it("defines a strict send_file contract without a voice escape hatch", () => {
    expect(sendFileTool).toMatchObject({
      name: "send_file",
      strict: true,
      parameters: {
        additionalProperties: false,
        required: ["path", "kind", "name"]
      }
    });
    expect(sendFileTool.parameters.properties.kind.enum).toEqual(["auto", "file", "image"]);
  });

  it("defines voice as a separate strict tool", () => {
    expect(sendVoiceMessageTool).toMatchObject({
      name: "send_voice_message",
      strict: true,
      parameters: {
        additionalProperties: false,
        required: ["text"]
      }
    });
    expect(createSendVoiceMessageTool(["ja"], "ja").parameters.properties)
      .toEqual(sendVoiceMessageTool.parameters.properties);
  });

  it("normalizes file and voice inputs and rejects invalid kinds", () => {
    expect(readSendFileInput({ path: " exports/report.pdf ", kind: "auto", name: null })).toEqual({
      path: "exports/report.pdf",
      kind: "auto"
    });
    expect(readSendFileInput({ path: "exports/pixel.png", kind: "image", name: " 结果图.png " })).toEqual({
      path: "exports/pixel.png",
      kind: "image",
      name: "结果图.png"
    });
    expect(readSendVoiceMessageInput({ text: " おはよう、先生。 " })).toEqual({
      text: "おはよう、先生。"
    });
    expect(() => readSendFileInput({ path: "x", kind: "voice", name: null })).toThrow(
      "auto, file, or image"
    );
    expect(() => readSendFileInput({ path: "/private/var/agent/workbench/report.txt", kind: "file", name: null }))
      .toThrow("relative");
    expect(() => readSendFileInput({ path: "exports/../secret.txt", kind: "file", name: null }))
      .toThrow("traversal");
    expect(() => readSendFileInput({ path: "exports\\report.txt", kind: "file", name: null }))
      .toThrow("POSIX");
    expect(() => readSendFileInput({ path: "exports/report.txt", kind: "file" }))
      .toThrow("must include path, kind, and name");
    expect(() => readSendFileInput({
      path: "exports/report.txt",
      kind: "file",
      name: null,
      accountId: "primary"
    } as never)).toThrow("unsupported fields");
    expect(() => readSendVoiceMessageInput({ text: "おはよう", language: "ja" } as never))
      .toThrow("only text");
    expect(() => readSendVoiceMessageInput({ text: "おはよう", path: "x.wav" } as never))
      .toThrow("only text");
    expect(() => readSendVoiceMessageInput({ text: "x".repeat(301) }))
      .toThrow("300 characters");
  });

  it.each([
    { systemCode: "ENOENT", publicCode: "SEND_FILE_SOURCE_MISSING" },
    { systemCode: "EACCES", publicCode: "SEND_FILE_SOURCE_FORBIDDEN" },
    { systemCode: "EIO", publicCode: "SEND_FILE_SOURCE_UNAVAILABLE" },
    { systemCode: "ENAMETOOLONG", publicCode: "SEND_FILE_SOURCE_UNAVAILABLE" }
  ])("keeps $systemCode host paths out of tool output and request logs", async ({ systemCode, publicCode }) => {
    appendRequestLog.mockClear();
    const hostPath = "/private/var/sunabot/agent-workspace/workbench/exports/missing.txt";
    const executor = new RegistryProviderToolExecutor();
    const options = {
      conversationAssets: {
        enabled: true,
        send: async () => {
          throw normalizeOutboundConversationAssetError(Object.assign(
            new Error(`${systemCode}: filesystem failure at ${hostPath}`),
            { code: systemCode, path: hostPath, syscall: "open" }
          ));
        }
      }
    } satisfies ProviderCompleteOptions;
    const definitions = executor.resolveDefinitions(options, [{ type: "function", function: sendFileTool }]);

    const [output] = await executor.execute([{
      type: "function_call",
      name: "send_file",
      call_id: `call-${systemCode.toLowerCase()}`,
      arguments: JSON.stringify({ path: "exports/missing.txt", kind: "file", name: null })
    }], options, definitions);

    const serializedOutput = String(output?.output);
    expect(JSON.parse(serializedOutput)).toEqual({
      ok: false,
      error: expect.stringContaining(publicCode)
    });
    expect(serializedOutput).not.toContain(hostPath);
    const serializedLog = JSON.stringify(appendRequestLog.mock.calls);
    expect(serializedLog).toContain(publicCode);
    expect(serializedLog).not.toContain(hostPath);
  });
});
