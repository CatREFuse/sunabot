// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
const requestLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../src/requestLog.js", () => ({ appendRequestLog: requestLog }));

import {
  RegistryProviderToolExecutor,
  mcpToolLogSummary
} from "../../adapters/model/provider/toolExecutor.js";
import type { ProviderCompleteOptions } from "../../adapters/model/provider/contracts.js";

const MCP_TOOL_NAME = `mcp_${"a".repeat(48)}`;

describe("Provider extension tools", () => {
  it("injects activate_skill only with approved runtime IDs and rejects forged IDs before activation", async () => {
    const activate = vi.fn(async ({ skillId }: { skillId: string }) => ({ ok: true, skillId }));
    const readResource = vi.fn(async ({ skillId, path }: { skillId: string; path: string }) => ({
      ok: true, skillId, path, byteLength: 5, sha256: "a".repeat(64), encoding: "utf8", content: "guide"
    }));
    const options = {
      skills: { skillIds: ["approved-skill"], activate, readResource }
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    expect(definitions).toContainEqual(expect.objectContaining({
      name: "activate_skill",
      parameters: expect.objectContaining({
        properties: { skillId: { type: "string", enum: ["approved-skill"] } }
      })
    }));
    const forged = await executor.execute([
      call("forged", "activate_skill", { skillId: "unreviewed-skill" })
    ], options, definitions);
    expect(JSON.parse(String(forged[0]!.output))).toEqual({
      ok: false, error: "SKILL_ACTIVATION_ARGUMENTS_INVALID"
    });
    expect(activate).not.toHaveBeenCalled();
    const accepted = await executor.execute([
      call("accepted", "activate_skill", { skillId: "approved-skill" })
    ], options, definitions);
    expect(JSON.parse(String(accepted[0]!.output))).toEqual({ ok: true, skillId: "approved-skill" });

    const resource = await executor.execute([
      call("resource", "read_skill_resource", { skillId: "approved-skill", path: "references/guide.md" })
    ], options, definitions);
    expect(JSON.parse(String(resource[0]!.output))).toMatchObject({ ok: true, content: "guide" });
    expect(readResource).toHaveBeenCalledOnce();

    requestLog.mockClear();
    await executor.execute([
      call("resource-log", "read_skill_resource", { skillId: "approved-skill", path: "references/guide.md" })
    ], options, definitions);
    expect(JSON.stringify(requestLog.mock.calls)).not.toContain('"content":"guide"');
  });

  it("does not declare Skill script execution without a runtime capability and rejects forged calls before side effects", async () => {
    const activate = vi.fn();
    const readResource = vi.fn();
    const options = {
      skills: { skillIds: ["approved-skill"], activate, readResource }
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);

    expect(definitions.map((definition) => definition.name)).not.toContain("run_skill_script");
    const forged = await executor.execute([
      call("forged-script", "run_skill_script", {
        skillId: "approved-skill",
        path: "scripts/run.sh",
        args: []
      })
    ], options, definitions);
    expect(JSON.parse(String(forged[0]!.output))).toEqual({
      ok: false,
      error: "Tool run_skill_script is unavailable."
    });
    expect(activate).not.toHaveBeenCalled();
    expect(readResource).not.toHaveBeenCalled();
  });

  it("dispatches only definitions from the dynamic MCP port and rejects mixed batches before calls", async () => {
    const callMcp = vi.fn(async () => ({ ok: true, content: [] }));
    const name = MCP_TOOL_NAME;
    const options = {
      mcp: {
        definitions: () => [{
          type: "function", name, description: "External MCP input",
          parameters: { type: "object", additionalProperties: false, properties: {} }, strict: true
        }],
        describe: () => ({ serverId: "server-a", transport: "streamable_http" }),
        call: callMcp
      },
      memory: { enabled: true, recall: vi.fn() }
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    expect(definitions.map((definition) => definition.name)).toEqual([name]);
    const output = await executor.execute([call("mcp", name, { query: "test" })], options, definitions);
    expect(JSON.parse(String(output[0]!.output))).toEqual({ ok: true, content: [] });
    expect(callMcp).toHaveBeenCalledWith({
      name, arguments: { query: "test" }, callId: "mcp", signal: undefined
    });

    callMcp.mockClear();
    const mixed = await executor.execute([
      call("mcp-2", name, { query: "test" }),
      call("memory", "memory_recall", { query: "private" })
    ], options, definitions);
    expect(mixed.map((item) => JSON.parse(String(item.output)))).toEqual([
      { ok: false, error: "MCP tools must be called alone before any other tool." },
      { ok: false, error: "MCP tools must be called alone before any other tool." }
    ]);
    expect(callMcp).not.toHaveBeenCalled();
  });

  it("logs MCP results as inert structural summaries without external values", async () => {
    requestLog.mockClear();
    const name = MCP_TOOL_NAME;
    const callMcp = vi.fn(async () => ({
      isError: true,
      content: [{ type: "text", text: "token-secret /Users/private C:\\secret" }],
      error: "file:///etc/passwd"
    }));
    const options = {
      mcp: {
        definitions: () => [{ type: "function", name, parameters: { type: "object" }, strict: true }],
        describe: () => ({ serverId: "server-a", transport: "streamable_http" }),
        call: callMcp
      }
    } satisfies ProviderCompleteOptions;
    const executor = new RegistryProviderToolExecutor();
    const definitions = executor.resolveDefinitions(options, []);
    await executor.execute([call("mcp-log", name, {})], options, definitions);
    const logEntry = requestLog.mock.calls.at(-1)?.[0] as { response?: unknown };
    expect(logEntry.response).toEqual(expect.objectContaining({
      status: "error",
      isError: true,
      contentCount: 1,
      contentTypes: ["text"]
    }));
    const serialized = JSON.stringify(logEntry.response);
    expect(serialized).not.toContain("token-secret");
    expect(serialized).not.toContain("/Users/private");
    expect(serialized).not.toContain("C:\\secret");
    expect(serialized).not.toContain("file:///etc/passwd");
  });

  it("summarizes getters, cycles, toJSON hooks and hostile proxies without invoking them", () => {
    const getter = vi.fn(() => "token-secret");
    const toJson = vi.fn(() => ({ token: "token-secret" }));
    const cyclic: Record<string, unknown> = { content: [{ type: "text", text: "secret" }] };
    cyclic.self = cyclic;
    Object.defineProperty(cyclic, "credential", { enumerable: true, get: getter });
    Object.defineProperty(cyclic, "toJSON", { enumerable: false, value: toJson });
    const summary = mcpToolLogSummary(cyclic);
    expect(summary).toEqual(expect.objectContaining({ status: "received", contentTypes: ["text"], truncated: true }));
    expect(getter).not.toHaveBeenCalled();
    expect(toJson).not.toHaveBeenCalled();
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("/Users/private token-secret"); } });
    expect(mcpToolLogSummary(hostile)).toEqual({
      status: "uninspectable",
      isError: false,
      contentCount: 0,
      contentTypes: [],
      byteCount: 0,
      truncated: true
    });
  });
});

function call(callId: string, name: string, args: Record<string, unknown>) {
  return { type: "function_call" as const, call_id: callId, name, arguments: JSON.stringify(args) };
}
