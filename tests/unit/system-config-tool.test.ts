// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  SYSTEM_CONFIG_OPERATIONS,
  SYSTEM_CONFIG_TOOL_NAME,
  parseSystemConfigInput,
  runSystemConfig,
  systemConfigTool,
  type SystemConfigInput,
  type SystemConfigToolPort
} from "../../services/tools/systemConfigTool.js";

describe("system_config tool contract", () => {
  it("publishes a strict closed schema with every nullable field required", () => {
    expect(systemConfigTool.type).toBe("function");
    expect(systemConfigTool.name).toBe(SYSTEM_CONFIG_TOOL_NAME);
    expect(systemConfigTool.strict).toBe(true);
    expect(systemConfigTool.parameters.additionalProperties).toBe(false);
    expect(systemConfigTool.parameters.properties.operation.enum).toEqual(SYSTEM_CONFIG_OPERATIONS);
    expect(systemConfigTool.parameters.properties.searchImplementation.enum).toEqual(["tavily", null]);
    expect(systemConfigTool.parameters.properties.bashAdminBackend.enum).toEqual(["native", "docker", null]);
    expect(systemConfigTool.parameters.required).toEqual([
      "operation",
      "replyScope",
      "enabled",
      "orchestratorEnabled",
      "searchImplementation",
      "bashAdminBackend",
      "conversationId"
    ]);
    expect(systemConfigTool.parameters.required).toEqual(
      Object.keys(systemConfigTool.parameters.properties)
    );
  });

  it.each([
    ["get_settings", input("get_settings")],
    ["get_status", input("get_status")],
    ["set_auto_reply", input("set_auto_reply", { replyScope: "all", enabled: true })],
    ["set_orchestrator", input("set_orchestrator", { enabled: false })],
    ["set_search", input("set_search", { enabled: true, searchImplementation: "tavily" })],
    ["set_search without changing implementation", input("set_search", { enabled: false })],
    ["set_bash_admin_backend native", input("set_bash_admin_backend", { bashAdminBackend: "native" })],
    ["set_bash_admin_backend docker", input("set_bash_admin_backend", { bashAdminBackend: "docker" })],
    ["set_group_reply reply switch", input("set_group_reply", {
      enabled: true,
      conversationId: "group:123"
    })],
    ["set_group_reply orchestrator switch", input("set_group_reply", {
      orchestratorEnabled: false,
      conversationId: "account:primary:group:123"
    })],
    ["set_group_reply both switches", input("set_group_reply", {
      enabled: true,
      orchestratorEnabled: true,
      conversationId: "group:456"
    })]
  ])("accepts the legal %s shape", (_label, value) => {
    expect(parseSystemConfigInput(value)).toEqual({ ok: true, input: value });
  });

  it("normalizes whitespace around a legal conversation id", () => {
    const result = parseSystemConfigInput(input("set_group_reply", {
      enabled: true,
      conversationId: "  group:123  "
    }));

    expect(result).toEqual({
      ok: true,
      input: input("set_group_reply", { enabled: true, conversationId: "group:123" })
    });
  });

  it.each([
    ["get_settings with a mutation value", input("get_settings", { enabled: true }), "get_settings"],
    ["get_status with a mutation value", input("get_status", { conversationId: "group:123" }), "get_status"],
    ["set_auto_reply without replyScope", input("set_auto_reply", { enabled: true }), "set_auto_reply"],
    ["set_auto_reply without enabled", input("set_auto_reply", { replyScope: "private" }), "set_auto_reply"],
    ["set_auto_reply with an unrelated field", input("set_auto_reply", {
      replyScope: "private",
      enabled: true,
      orchestratorEnabled: false
    }), "set_auto_reply"],
    ["set_orchestrator without enabled", input("set_orchestrator"), "set_orchestrator"],
    ["set_orchestrator with replyScope", input("set_orchestrator", {
      replyScope: "all",
      enabled: true
    }), "set_orchestrator"],
    ["set_search without enabled", input("set_search", { searchImplementation: "tavily" }), "set_search"],
    ["set_search with a group field", input("set_search", {
      enabled: true,
      conversationId: "group:123"
    }), "set_search"],
    ["set_bash_admin_backend without a backend", input("set_bash_admin_backend"), "set_bash_admin_backend"],
    ["set_bash_admin_backend with enabled", input("set_bash_admin_backend", {
      enabled: true,
      bashAdminBackend: "native"
    }), "set_bash_admin_backend"],
    ["set_group_reply without conversationId", input("set_group_reply", { enabled: true }), "set_group_reply"],
    ["set_group_reply without either switch", input("set_group_reply", {
      conversationId: "group:123"
    }), "set_group_reply"],
    ["set_group_reply with replyScope", input("set_group_reply", {
      replyScope: "user_group",
      enabled: true,
      conversationId: "group:123"
    }), "set_group_reply"],
    ["set_group_reply with a search implementation", input("set_group_reply", {
      enabled: true,
      searchImplementation: "tavily",
      conversationId: "group:123"
    }), "set_group_reply"]
  ])("rejects %s", (_label, value, field) => {
    expect(parseSystemConfigInput(value)).toMatchObject({
      ok: false,
      code: "SYSTEM_CONFIG_INVALID",
      field
    });
  });

  it("rejects unknown fields before operation execution", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const port = toolPort(execute);

    await expect(runSystemConfig({
      ...input("get_settings"),
      rawConfig: true
    }, port)).resolves.toMatchObject({
      ok: false,
      code: "SYSTEM_CONFIG_INVALID",
      field: "rawConfig"
    });
    expect(execute).not.toHaveBeenCalled();
    expect(port.mutationStaged()).toBe(false);
  });

  it("rejects unsupported search implementations before operation execution", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const port = toolPort(execute);

    await expect(runSystemConfig({
      ...input("set_search", { enabled: true }),
      searchImplementation: "codex"
    }, port)).resolves.toMatchObject({
      ok: false,
      code: "SYSTEM_CONFIG_INVALID",
      field: "searchImplementation",
      error: "Unsupported search implementation."
    });
    expect(execute).not.toHaveBeenCalled();
    expect(port.mutationStaged()).toBe(false);
  });

  it("rejects unsupported administrator Bash backends before operation execution", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const port = toolPort(execute);

    await expect(runSystemConfig({
      ...input("set_bash_admin_backend"),
      bashAdminBackend: "host"
    }, port)).resolves.toMatchObject({
      ok: false,
      code: "SYSTEM_CONFIG_INVALID",
      field: "bashAdminBackend",
      error: "Unsupported administrator Bash backend."
    });
    expect(execute).not.toHaveBeenCalled();
    expect(port.mutationStaged()).toBe(false);
  });

  it("passes parsed input to the port and exposes its staged-mutation state", async () => {
    let staged = false;
    const execute = vi.fn(async (value: SystemConfigInput) => {
      staged = true;
      return { ok: true, operation: value.operation, effectiveFrom: "next_turn" };
    });
    const port = {
      execute,
      mutationStaged: () => staged,
      rejectTurn: () => undefined,
      turnRejected: () => false
    } satisfies SystemConfigToolPort;
    const value = input("set_orchestrator", { enabled: true });

    expect(port.mutationStaged()).toBe(false);
    await expect(runSystemConfig(value, port)).resolves.toEqual({
      ok: true,
      operation: "set_orchestrator",
      effectiveFrom: "next_turn"
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(value);
    expect(port.mutationStaged()).toBe(true);
  });
});

function input(
  operation: SystemConfigInput["operation"],
  overrides: Partial<SystemConfigInput> = {}
): SystemConfigInput {
  return {
    operation,
    replyScope: null,
    enabled: null,
    orchestratorEnabled: null,
    searchImplementation: null,
    bashAdminBackend: null,
    conversationId: null,
    ...overrides
  };
}

function toolPort(execute: SystemConfigToolPort["execute"]): SystemConfigToolPort {
  return {
    execute,
    mutationStaged: () => false,
    rejectTurn: () => undefined,
    turnRejected: () => false
  };
}
