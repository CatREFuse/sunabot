import { describe, expect, it, vi } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import { listToolMetadata } from "../../services/tools/toolRegistry.js";

describe("knowledge_search tool", () => {
  it("is default-enabled only when the current Agent knowledge port is available", () => {
    expect(listToolMetadata({ knowledge: { enabled: true, search: vi.fn() } }, [])
      .find((tool) => tool.name === "knowledge_search")).toMatchObject({
        enabled: true,
        available: true,
        effectiveEnabled: true,
        execution: "inline"
      });
    expect(listToolMetadata({}, []).find((tool) => tool.name === "knowledge_search")).toMatchObject({
      available: false,
      effectiveEnabled: false
    });
  });

  it("executes BM25 search through the provider port", async () => {
    const search = vi.fn(async () => ({
      ok: true,
      query: "火星供电",
      matches: [{ path: "space/mars.md", startLine: 1, endLine: 1, content: "火星基地采用核能供电。" }]
    }));
    const executor = new RegistryProviderToolExecutor();
    const options = { knowledge: { enabled: true, search } };
    const definitions = executor.resolveDefinitions(options, []);
    const [output] = await executor.execute(
      [{ type: "function_call", call_id: "knowledge-1", name: "knowledge_search", arguments: JSON.stringify({ query: "火星供电", limit: 5 }) }],
      options,
      definitions,
      { toolCallCount: 0, assistantTextSent: false, assistantTextDeliveryCount: 0, acceptedToolNames: [] }
    );
    const result = JSON.parse(output!.output);

    expect(result).toMatchObject({ ok: true, query: "火星供电" });
    expect(search).toHaveBeenCalledWith({ query: "火星供电", limit: 5 });
  });
});
