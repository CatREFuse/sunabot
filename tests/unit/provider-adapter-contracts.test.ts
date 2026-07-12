// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import {
  extractResponsesTextFromSse,
  parseResponsesSsePayload
} from "../../adapters/model/provider/streamDecoder.js";
import { fetchWithSingleTransportRetry } from "../../adapters/model/provider/transport.js";

describe("provider adapter ports", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decodes Codex SSE output items and completed text", () => {
    const message = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "完成" }]
    };
    const stream = [
      `data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: message })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [message] } })}`
    ].join("\n\n");

    expect(parseResponsesSsePayload(stream)).toMatchObject({
      status: "completed",
      output: [message]
    });
    expect(extractResponsesTextFromSse(stream)).toBe("完成");
  });

  it("retries one transport failure without changing the request", async () => {
    const response = new Response("ok", { status: 200 });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(response);
    const init: RequestInit = { method: "POST", body: "{}" };

    await expect(fetchWithSingleTransportRetry("https://example.test/responses", init)).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls).toEqual([
      ["https://example.test/responses", init],
      ["https://example.test/responses", init]
    ]);
  });

  it("keeps unsupported tool dispatch inside the ToolExecutor boundary", async () => {
    const executor = new RegistryProviderToolExecutor();
    const [output] = await executor.execute([{
      type: "function_call",
      name: "unknown_tool",
      call_id: "call_unknown",
      arguments: "{}"
    }], {}, []);

    expect(output).toMatchObject({
      type: "function_call_output",
      call_id: "call_unknown"
    });
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Unsupported tool: unknown_tool"
    });
  });
});
