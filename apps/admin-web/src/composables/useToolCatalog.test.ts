import { beforeEach, describe, expect, it, vi } from "vitest";
import { useToolCatalog } from "./useToolCatalog";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("useToolCatalog", () => {
  beforeEach(() => apiRequest.mockReset());

  it("loads lazily and preserves the current tool metadata shape", async () => {
    apiRequest.mockResolvedValueOnce({
      tools: [{
        name: "websearch",
        title: "网页搜索",
        summary: "搜索网页并返回结果。",
        execution: "inline",
        configuredEnabled: null,
        promptEnabled: true,
        enabled: true,
        available: false,
        effectiveEnabled: false,
        availabilityReason: "网页搜索配置不可用。",
        defaultDescription: "Default search description.",
        promptDescription: "Prompt search description.",
        description: "Prompt search description.",
        descriptionSource: "prompt",
        parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        strict: true
      }]
    });
    const catalog = useToolCatalog();
    expect(apiRequest).not.toHaveBeenCalled();

    await catalog.load();

    expect(apiRequest).toHaveBeenCalledWith("/api/tools");
    expect(catalog.tools.value[0]).toMatchObject({
      name: "websearch",
      configuredEnabled: null,
      promptEnabled: true,
      available: false,
      effectiveEnabled: false,
      availabilityReason: "网页搜索配置不可用。"
    });
    await catalog.load();
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("normalizes the legacy compact payload", async () => {
    apiRequest.mockResolvedValueOnce({
      tools: [{ name: "codex", title: "Codex", description: "异步任务", enabled: true }]
    });
    const catalog = useToolCatalog();

    await catalog.load();

    expect(catalog.tools.value[0]).toMatchObject({
      name: "codex",
      summary: "异步任务",
      execution: "deferred",
      configuredEnabled: true,
      available: true,
      defaultDescription: "异步任务"
    });
  });

  it("keeps the newest forced refresh result", async () => {
    const first = deferred<{ tools: unknown[] }>();
    const second = deferred<{ tools: unknown[] }>();
    apiRequest.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const catalog = useToolCatalog();

    const initial = catalog.load();
    const refresh = catalog.load(true);
    second.resolve({ tools: [{ name: "selfie", title: "自拍", description: "new", enabled: true }] });
    await refresh;
    first.resolve({ tools: [{ name: "websearch", title: "网页搜索", description: "old", enabled: true }] });
    await initial;

    expect(catalog.tools.value.map((tool) => tool.name)).toEqual(["selfie"]);
  });
});
