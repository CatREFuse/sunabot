// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { refreshMcpCatalog } from "../../services/extensions/mcpCatalogSnapshot.js";

describe("MCP catalog snapshot", () => {
  it("fully paginates each negotiated primitive and atomically publishes a digest", async () => {
    const client = clientMock();
    client.listTools
      .mockResolvedValueOnce({ items: [{ name: "first", outputSchema: { type: "string" } }], nextCursor: "p2" })
      .mockResolvedValueOnce({ items: [{ name: "second" }] });
    const result = await refreshMcpCatalog({
      client,
      capabilities: { tools: true, resources: true, prompts: true },
      now: () => new Date("2026-07-17T00:00:00.000Z")
    });
    expect(result.status).toBe("ready");
    expect(result.snapshot?.tools).toEqual([
      { name: "first", outputSchema: { type: "string" } },
      { name: "second" }
    ]);
    expect(result.snapshot?.digestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(client.listTools.mock.calls.map((call) => call[0])).toEqual([undefined, "p2"]);
    expect(client.listTools.mock.calls[0]![1]).toMatchObject({
      timeout: 10_000, maxTotalTimeout: 30_000, resetTimeoutOnProgress: false
    });
  });

  it("keeps the previous snapshot when a later page fails or cursors loop", async () => {
    const prior = (await refreshMcpCatalog({
      client: clientMock(), capabilities: { tools: true }, now: () => new Date(0)
    })).snapshot!;
    const failing = clientMock();
    failing.listTools.mockReset()
      .mockResolvedValueOnce({ items: [{ name: "partial" }], nextCursor: "again" })
      .mockRejectedValueOnce(new Error("page failed"));
    await expect(refreshMcpCatalog({ client: failing, capabilities: { tools: true }, previous: prior }))
      .resolves.toEqual({ status: "degraded", snapshot: prior, errorCode: "MCP_CATALOG_REFRESH_FAILED" });

    const looping = clientMock();
    looping.listTools.mockReset().mockResolvedValue({ items: [], nextCursor: "again" });
    expect((await refreshMcpCatalog({ client: looping, capabilities: { tools: true }, previous: prior })).snapshot)
      .toBe(prior);
  });

  it.each([
    { name: "bad\u0007tool" },
    { name: "bad\ud800tool" },
    { name: "bad tool" },
    { name: "a".repeat(129) }
  ])("degrades atomically for unsafe tool identity %#", async (tool) => {
    const client = clientMock();
    client.listTools.mockResolvedValue({ items: [tool] });
    await expect(refreshMcpCatalog({ client, capabilities: { tools: true } })).resolves.toEqual({
      status: "degraded", snapshot: null, errorCode: "MCP_CATALOG_REFRESH_FAILED"
    });
  });

  it("normalizes external descriptions but rejects proxy/accessor catalog data without invoking it", async () => {
    const getter = vi.fn(() => "secret");
    const safe = clientMock();
    safe.listTools.mockResolvedValue({ items: [{ name: "safe", description: "line\u0007 two" }] });
    const ready = await refreshMcpCatalog({ client: safe, capabilities: { tools: true } });
    expect(ready.snapshot?.tools).toEqual([{
      name: "safe", description: "[External MCP input] line two"
    }]);

    for (const hostile of [
      Object.defineProperty({ name: "hostile" }, "description", { enumerable: true, get: getter }),
      new Proxy({ name: "hostile" }, { ownKeys: getter })
    ]) {
      const client = clientMock();
      client.listTools.mockResolvedValue({ items: [hostile] });
      const result = await refreshMcpCatalog({ client, capabilities: { tools: true } });
      expect(result.status).toBe("degraded");
    }
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects control characters and unpaired surrogates in resource, prompt and cursor identities", async () => {
    const cases = [
      (client: ReturnType<typeof clientMock>) => client.listResources.mockResolvedValue({ items: [{ uri: "https://x/\u0001" }] }),
      (client: ReturnType<typeof clientMock>) => client.listResourceTemplates.mockResolvedValue({ items: [{ uriTemplate: "https://x/{\ud800}" }] }),
      (client: ReturnType<typeof clientMock>) => client.listPrompts.mockResolvedValue({ items: [{ name: "bad prompt" }] }),
      (client: ReturnType<typeof clientMock>) => client.listTools.mockResolvedValue({ items: [], nextCursor: "bad\u0085cursor" })
    ];
    for (const arrange of cases) {
      const client = clientMock();
      arrange(client);
      const result = await refreshMcpCatalog({
        client,
        capabilities: { tools: true, resources: true, prompts: true }
      });
      expect(result.status).toBe("degraded");
    }
  });
});

function clientMock() {
  return {
    listTools: vi.fn(async () => ({ items: [{ name: "tool" }] })),
    listResources: vi.fn(async () => ({ items: [{ uri: "https://example.test/resource" }] })),
    listResourceTemplates: vi.fn(async () => ({ items: [{ uriTemplate: "https://example.test/{id}" }] })),
    listPrompts: vi.fn(async () => ({ items: [{ name: "prompt" }] }))
  };
}
