// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { runWorkspaceBashMock } = vi.hoisted(() => ({
  runWorkspaceBashMock: vi.fn()
}));

vi.mock("../../services/tools/bashTool.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../services/tools/bashTool.js")>(),
  runWorkspaceBash: runWorkspaceBashMock
}));

import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import type { BashAuditRunner } from "../../services/tools/bashAudit.js";

describe("workspace Bash Provider wiring", () => {
  beforeEach(() => {
    runWorkspaceBashMock.mockReset().mockResolvedValue({ ok: true, stdout: "/workbench\n" });
  });

  it("passes the audited backend, access mode, approval binding, and abort signal atomically", async () => {
    const executor = new RegistryProviderToolExecutor();
    const controller = new AbortController();
    const audit: BashAuditRunner = vi.fn();
    const isCurrent = vi.fn(() => true);
    const approvalContext = {
      agentId: "plana",
      accountId: "secondary",
      transport: "onebot",
      conversationId: "account:secondary:private:171419991",
      userId: "171419991"
    };
    const options = {
      signal: controller.signal,
      bash: {
        enabled: true,
        workspacePath: "/fixture/agent-workspace",
        backend: "docker",
        accessMode: "admin",
        strictMode: true,
        isCurrent,
        audit,
        approvalContext,
        confirmedApprovalId: "bash-1234567890abcdef12345678"
      }
    } satisfies ProviderCompleteOptions;
    const definitions = executor.resolveDefinitions(options);

    expect(definitions.map((definition) => definition.name)).toContain("workspace_bash");
    const [output] = await executor.execute([bashCall({ command: "pwd", timeoutMs: null })], options, definitions);

    expect(JSON.parse(String(output?.output))).toMatchObject({ ok: true });
    expect(runWorkspaceBashMock).toHaveBeenCalledWith(
      { command: "pwd", timeoutMs: null },
      "/fixture/agent-workspace",
      {
        backend: "docker",
        accessMode: "admin",
        strictMode: true,
        isCurrent,
        audit,
        approvalContext,
        confirmedApprovalId: "bash-1234567890abcdef12345678",
        abortSignal: controller.signal
      }
    );
  });

  it("rejects undeclared or partially wired forged calls without starting the sandbox", async () => {
    const executor = new RegistryProviderToolExecutor();
    const incomplete = {
      bash: {
        enabled: true,
        workspacePath: "/fixture/agent-workspace",
        backend: "docker",
        accessMode: "admin",
        strictMode: true,
        audit: vi.fn()
      }
    } as unknown as ProviderCompleteOptions;
    const staleDefinitions = [{ type: "function", name: "workspace_bash", parameters: {}, strict: true }];

    expect(executor.resolveDefinitions(incomplete).map((definition) => definition.name)).not.toContain("workspace_bash");
    const [output] = await executor.execute([bashCall({ command: "pwd", timeoutMs: null })], incomplete, staleDefinitions);

    expect(JSON.parse(String(output?.output))).toEqual({ ok: false, error: "Tool workspace_bash is unavailable." });
    expect(runWorkspaceBashMock).not.toHaveBeenCalled();
  });

  it("rejects non-canonical Bash arguments before starting the sandbox", async () => {
    const executor = new RegistryProviderToolExecutor();
    const options = completeOptions();
    const definitions = executor.resolveDefinitions(options);

    const [output] = await executor.execute([
      bashCall({ command: "pwd", timeoutMs: null, injected: true })
    ], options, definitions);

    expect(JSON.parse(String(output?.output))).toEqual({ ok: false, error: "Invalid Bash arguments." });
    expect(runWorkspaceBashMock).not.toHaveBeenCalled();
  });

  it("treats an isCurrent getter exception as stale before the Bash runner", async () => {
    const executor = new RegistryProviderToolExecutor();
    const audit = vi.fn();
    const options = completeOptions();
    options.bash!.audit = audit;
    options.bash!.isCurrent = () => { throw new Error("getter failed"); };
    const definitions = executor.resolveDefinitions(options);

    const [output] = await executor.execute(
      [bashCall({ command: "pwd", timeoutMs: null })],
      options,
      definitions
    );

    expect(JSON.parse(String(output?.output))).toEqual({ ok: false, error: "Bash is not enabled." });
    expect(audit).not.toHaveBeenCalled();
    expect(runWorkspaceBashMock).not.toHaveBeenCalled();
  });
});

function completeOptions(): ProviderCompleteOptions {
  return {
    bash: {
      enabled: true,
      workspacePath: "/fixture/agent-workspace",
      backend: "docker",
      accessMode: "admin",
      strictMode: true,
      isCurrent: () => true,
      audit: vi.fn(),
      approvalContext: {
        agentId: "plana",
        accountId: "primary",
        transport: "onebot",
        conversationId: "private:171419991",
        userId: "171419991"
      }
    }
  };
}

function bashCall(args: Record<string, unknown>) {
  return {
    type: "function_call" as const,
    name: "workspace_bash",
    call_id: "call-bash",
    arguments: JSON.stringify(args)
  };
}
