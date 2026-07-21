// @vitest-environment node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bashToolMockState, processState, runWorkspaceBashMock } = vi.hoisted(() => ({
  bashToolMockState: { runActual: false },
  processState: { calls: [] as Array<{ file: string; args: string[] }> },
  runWorkspaceBashMock: vi.fn()
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn((
    file: string,
    args: string[],
    _options: Record<string, unknown>,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    processState.calls.push({ file, args: [...args] });
    queueMicrotask(() => callback(null, "ok", ""));
    return { kill: () => true };
  })
}));

vi.mock("../../services/tools/bashTool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/tools/bashTool.js")>();
  return {
    ...actual,
    runWorkspaceBash: (...args: Parameters<typeof actual.runWorkspaceBash>) => (
      bashToolMockState.runActual
        ? actual.runWorkspaceBash(...args)
        : runWorkspaceBashMock(...args)
    )
  };
});

import type { ProviderCompleteOptions } from "../../adapters/model/openaiProvider.js";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import { BashApprovalStore, type BashAuditInput, type BashAuditResult } from "../../services/tools/bashAudit.js";
import type { RuntimeToolCapabilityResolver } from "../../services/tools/bashCapability.js";
import { runWorkspaceBash } from "../../services/tools/bashTool.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";
import { SunaRuntime } from "../../src/runtime.js";
import type { RuntimeBashAuditPort } from "../../src/runtime/runtimeContracts.js";
import type { AppConfig, ParsedIncomingMessage } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const secureScratchParent = path.dirname(fileURLToPath(import.meta.url));
let temporaryRoots: string[] = [];

describe("workspace Bash runtime wiring", () => {
  beforeEach(() => {
    bashToolMockState.runActual = false;
    processState.calls = [];
    runWorkspaceBashMock.mockReset().mockResolvedValue({ ok: true, stdout: "/workbench\n" });
  });

  afterEach(async () => {
    bashToolMockState.runActual = false;
    for (const root of temporaryRoots) await fs.rm(root, { recursive: true, force: true });
    temporaryRoots = [];
  });

  it("binds an administrator OneBot private call to Native Bash and the current approval context", async () => {
    const harness = createRuntimeHarness();
    harness.config.bot.bash.adminPrivateBackend = "docker";
    const incoming = adminPrivateIncoming(harness.config, {
      accountId: "secondary",
      text: "/确认 Bash bash-1234567890abcdef12345678"
    });

    const bash = await harness.runtime.resolveProviderBashHandle(incoming, undefined);

    expect(bash).toMatchObject({
      enabled: true,
      backend: "native",
      accessMode: "admin",
      strictMode: true,
      confirmedApprovalId: "bash-1234567890abcdef12345678",
      approvalContext: {
        agentId: "plana",
        accountId: "secondary",
        transport: "onebot",
        conversationId: "account:secondary:private:171419991",
        userId: "171419991"
      }
    });
    expect(harness.capabilityProbe).toHaveBeenCalledWith({
      workspacePath: harness.config.persona.agentWorkspace,
      workspaceBashBackend: "native",
      workspaceBashAuditAvailable: true
    });
    expect(Object.isFrozen(bash)).toBe(true);
    expect(Object.isFrozen(bash!.approvalContext)).toBe(true);
    const auditConfig = vi.mocked(harness.auditPort.available).mock.calls[0]?.[0];
    expect(auditConfig).not.toBe(harness.config);
    expect(Object.isFrozen(auditConfig)).toBe(true);
    expect(Object.isFrozen(auditConfig?.bot.bash)).toBe(true);

    const auditInput: BashAuditInput = {
      command: "pwd",
      backend: "native",
      accessMode: "admin",
      strictMode: true
    };
    await expect(bash!.audit(auditInput)).resolves.toMatchObject({ decision: "allow" });
    expect(vi.mocked(harness.auditPort.run).mock.calls[0]?.[0]).toBe(auditConfig);
    expect(harness.auditPort.run).toHaveBeenCalledWith(auditConfig, auditInput);
    harness.close();
  });

  it.each([
    ["private", adminPrivateIncoming] as const,
    ["group", adminGroupIncoming] as const
  ])("routes an ordinary QQ %s conversation to isolated Docker Bash", async (_scope, incomingFor) => {
    const harness = createRuntimeHarness();
    const incoming = incomingFor(harness.config, { userId: 20002, senderId: "20002" });

    const bash = await harness.runtime.resolveProviderBashHandle(incoming, undefined);

    expect(bash).toMatchObject({
      backend: "docker",
      accessMode: "isolated",
      strictMode: true,
      approvalContext: {
        agentId: "plana",
        accountId: "primary",
        transport: "onebot",
        userId: "20002"
      }
    });
    expect(harness.auditPort.available).toHaveBeenCalledOnce();
    expect(harness.capabilityProbe).toHaveBeenCalledWith(expect.objectContaining({
      workspaceBashBackend: "docker",
      workspaceBashAuditAvailable: true
    }));
    harness.close();
  });

  it("routes an administrator QQ group conversation to audited isolated Docker Bash", async () => {
    const harness = createRuntimeHarness();

    const bash = await harness.runtime.resolveProviderBashHandle(adminGroupIncoming(harness.config), undefined);

    expect(bash).toMatchObject({ backend: "docker", accessMode: "isolated" });
    expect(harness.capabilityProbe).toHaveBeenCalledWith(expect.objectContaining({
      workspaceBashBackend: "docker"
    }));
    await expect(bash!.audit({
      command: "pwd",
      backend: "docker",
      accessMode: "isolated",
      strictMode: true
    })).resolves.toMatchObject({ decision: "allow" });
    expect(harness.auditPort.run).toHaveBeenCalledOnce();
    harness.close();
  });

  it("routes a valid ordinary QQ conversation to Docker when administrator QQ is not configured", async () => {
    const harness = createRuntimeHarness();
    harness.config.bot.adminQq = "";

    const bash = await harness.runtime.resolveProviderBashHandle(
      adminPrivateIncoming(harness.config, { userId: 20002, senderId: "20002" }),
      undefined
    );

    expect(bash).toMatchObject({ backend: "docker", accessMode: "isolated" });
    expect(harness.capabilityProbe).toHaveBeenCalledWith(expect.objectContaining({
      workspaceBashBackend: "docker"
    }));
    harness.close();
  });

  it.each(negativeCases)("keeps audit, capability probe, and sandbox at zero for $name", async ({
    configure,
    incomingFor,
    promptOverride
  }) => {
    const harness = createRuntimeHarness();
    configure?.(harness.config);
    const incoming = incomingFor(harness.config);
    const bash = await harness.runtime.resolveProviderBashHandle(incoming, promptOverride);

    expect(bash).toBeUndefined();
    expect(harness.auditPort.available).not.toHaveBeenCalled();
    expect(harness.auditPort.run).not.toHaveBeenCalled();
    expect(harness.capabilityProbe).not.toHaveBeenCalled();

    const executor = new RegistryProviderToolExecutor();
    const staleDefinitions = [{ type: "function", name: "workspace_bash", parameters: {}, strict: true }];
    const [output] = await executor.execute(
      [bashCall({ command: "pwd", timeoutMs: null })],
      { bash } as ProviderCompleteOptions,
      staleDefinitions
    );
    expect(JSON.parse(String(output?.output))).toEqual({
      ok: false,
      error: "Tool workspace_bash is unavailable."
    });
    expect(runWorkspaceBashMock).not.toHaveBeenCalled();
    harness.close();
  });

  it("does not probe or expose Bash when the independent audit port is missing", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-bash-wiring-no-audit");
    const capabilityProbe = vi.fn(async () => ({ codex: true, workspaceBash: true }));
    const store = new SessionStore({ databasePath: ":memory:" });
    const runtime = new SunaRuntime(config, {
      attachmentService: {} as never,
      sessionStore: store,
      resolveToolCapabilities: capabilityProbe
    });

    await expect(runtime.resolveProviderBashHandle(adminPrivateIncoming(config), undefined)).resolves.toBeUndefined();
    expect(capabilityProbe).not.toHaveBeenCalled();
    runtime.close();
  });

  it("reports a missing independent audit as a safe runtime capability reason", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-bash-wiring-status-no-audit");
    const capabilityProbe = vi.fn(async () => ({ codex: true, workspaceBash: false }));
    const store = new SessionStore({ databasePath: ":memory:" });
    const runtime = new SunaRuntime(config, {
      attachmentService: {} as never,
      sessionStore: store,
      resolveToolCapabilities: capabilityProbe
    });

    await expect(runtime.resolveToolCapabilities()).resolves.toEqual({
      workspaceBash: false,
      workspaceBashReason: "BASH_AUDIT_UNAVAILABLE",
      codex: true
    });
    expect(capabilityProbe).toHaveBeenCalledWith(expect.objectContaining({
      workspaceBashAuditAvailable: false
    }));
    runtime.close();
  });

  it.each(["native", "docker"] as const)(
    "reports the selected %s isolation backend when its capability probe fails",
    async (backend) => {
      const capabilityProbe = vi.fn(async () => ({ codex: true, workspaceBash: false }));
      const harness = createRuntimeHarness(capabilityProbe);
      harness.config.bot.bash.adminPrivateBackend = backend;

      await expect(harness.runtime.resolveToolCapabilities(backend)).resolves.toEqual({
        workspaceBash: false,
        workspaceBashReason: backend === "native"
          ? "BASH_NATIVE_ISOLATION_UNAVAILABLE"
          : "BASH_DOCKER_ISOLATION_UNAVAILABLE",
        codex: true
      });
      expect(capabilityProbe).toHaveBeenCalledWith(expect.objectContaining({
        workspaceBashBackend: backend,
        workspaceBashAuditAvailable: true
      }));
      harness.close();
    }
  );

  it("retries runtime capabilities with one stable backend and workspace snapshot", async () => {
    const firstProbe = deferred<{ codex: boolean; workspaceBash: boolean }>();
    const capabilityProbe = vi.fn()
      .mockImplementationOnce(() => firstProbe.promise)
      .mockResolvedValue({ codex: true, workspaceBash: false });
    const harness = createRuntimeHarness(capabilityProbe);
    const capabilitiesPromise = harness.runtime.resolveToolCapabilities();
    await vi.waitFor(() => expect(capabilityProbe).toHaveBeenCalledTimes(1));

    const nextConfig = structuredClone(harness.runtime.config);
    nextConfig.persona.agentWorkspace = "/tmp/sunabot-bash-wiring-capability-b";
    nextConfig.bot.bash.adminPrivateBackend = "docker";
    harness.runtime.config = nextConfig;
    firstProbe.resolve({ codex: true, workspaceBash: false });

    await expect(capabilitiesPromise).resolves.toEqual({
      workspaceBash: false,
      workspaceBashReason: "BASH_NATIVE_ISOLATION_UNAVAILABLE",
      codex: true
    });
    expect(capabilityProbe.mock.calls.map(([context]) => context)).toEqual([
      expect.objectContaining({
        workspacePath: harness.config.persona.agentWorkspace,
        workspaceBashBackend: "native"
      }),
      expect.objectContaining({
        workspacePath: "/tmp/sunabot-bash-wiring-capability-b",
        workspaceBashBackend: "native"
      })
    ]);
    expect(vi.mocked(harness.auditPort.available).mock.calls.map(([config]) => ({
      workspacePath: config.persona.agentWorkspace,
      backend: config.bot.bash.adminPrivateBackend,
      frozen: Object.isFrozen(config) && Object.isFrozen(config.bot.bash)
    }))).toEqual([
      {
        workspacePath: harness.config.persona.agentWorkspace,
        backend: "native",
        frozen: true
      },
      {
        workspacePath: "/tmp/sunabot-bash-wiring-capability-b",
        backend: "docker",
        frozen: true
      }
    ]);
    harness.close();
  });

  it("fails runtime capabilities closed when both bounded snapshots drift", async () => {
    const firstProbe = deferred<{ codex: boolean; workspaceBash: boolean }>();
    const secondProbe = deferred<{ codex: boolean; workspaceBash: boolean }>();
    const capabilityProbe = vi.fn()
      .mockImplementationOnce(() => firstProbe.promise)
      .mockImplementationOnce(() => secondProbe.promise);
    const harness = createRuntimeHarness(capabilityProbe);
    const capabilitiesPromise = harness.runtime.resolveToolCapabilities();
    await vi.waitFor(() => expect(capabilityProbe).toHaveBeenCalledTimes(1));

    const configB = structuredClone(harness.runtime.config);
    configB.bot.bash.adminPrivateBackend = "docker";
    harness.runtime.config = configB;
    firstProbe.resolve({ codex: true, workspaceBash: true });
    await vi.waitFor(() => expect(capabilityProbe).toHaveBeenCalledTimes(2));

    const configC = structuredClone(configB);
    configC.persona.agentWorkspace = "/tmp/sunabot-bash-wiring-capability-c";
    configC.bot.bash.adminPrivateBackend = "native";
    harness.runtime.config = configC;
    secondProbe.resolve({ codex: true, workspaceBash: true });

    await expect(capabilitiesPromise).resolves.toEqual({
      workspaceBash: false,
      workspaceBashReason: "BASH_NATIVE_ISOLATION_UNAVAILABLE",
      codex: false
    });
    expect(capabilityProbe).toHaveBeenCalledTimes(2);
    expect(harness.auditPort.available).toHaveBeenCalledTimes(2);
    expect(harness.auditPort.run).not.toHaveBeenCalled();
    expect(runWorkspaceBashMock).not.toHaveBeenCalled();
    harness.close();
  });

  it("retries a delayed probe once with the new workspace snapshot and fixed administrator backend", async () => {
    const firstProbe = deferred<{ codex: boolean; workspaceBash: boolean }>();
    const capabilityProbe = vi.fn()
      .mockImplementationOnce(() => firstProbe.promise)
      .mockResolvedValue({ codex: true, workspaceBash: true });
    const harness = createRuntimeHarness(capabilityProbe);
    const handlePromise = harness.runtime.resolveProviderBashHandle(
      adminPrivateIncoming(harness.config),
      undefined
    );
    await vi.waitFor(() => expect(capabilityProbe).toHaveBeenCalledTimes(1));

    const nextConfig = structuredClone(harness.runtime.config);
    nextConfig.persona.agentWorkspace = "/tmp/sunabot-bash-wiring-runtime-b";
    nextConfig.bot.bash.adminPrivateBackend = "docker";
    harness.runtime.config = nextConfig;
    firstProbe.resolve({ codex: true, workspaceBash: true });

    await expect(handlePromise).resolves.toMatchObject({
      backend: "native",
      workspacePath: "/tmp/sunabot-bash-wiring-runtime-b"
    });
    expect(capabilityProbe.mock.calls.map(([context]) => context)).toEqual([
      expect.objectContaining({
        workspacePath: harness.config.persona.agentWorkspace,
        workspaceBashBackend: "native"
      }),
      expect.objectContaining({
        workspacePath: "/tmp/sunabot-bash-wiring-runtime-b",
        workspaceBashBackend: "native"
      })
    ]);
    expect(harness.auditPort.available).toHaveBeenCalledTimes(2);
    harness.close();
  });

  it("uses a monotonic epoch to detect an A-to-B-to-A config replacement", async () => {
    const firstProbe = deferred<{ codex: boolean; workspaceBash: boolean }>();
    const capabilityProbe = vi.fn()
      .mockImplementationOnce(() => firstProbe.promise)
      .mockResolvedValue({ codex: true, workspaceBash: true });
    const harness = createRuntimeHarness(capabilityProbe);
    const configA = structuredClone(harness.runtime.config);
    const handlePromise = harness.runtime.resolveProviderBashHandle(adminPrivateIncoming(configA), undefined);
    await vi.waitFor(() => expect(capabilityProbe).toHaveBeenCalledTimes(1));

    const epochA = harness.runtime.configEpoch;
    const configB = structuredClone(configA);
    configB.bot.bash.adminPrivateBackend = "docker";
    harness.runtime.config = configB;
    const epochB = harness.runtime.configEpoch;
    harness.runtime.config = structuredClone(configA);
    const restoredEpochA = harness.runtime.configEpoch;
    firstProbe.resolve({ codex: true, workspaceBash: true });

    const handle = await handlePromise;
    expect(epochB).toBeGreaterThan(epochA);
    expect(restoredEpochA).toBeGreaterThan(epochB);
    expect(capabilityProbe).toHaveBeenCalledTimes(2);
    expect(handle).toMatchObject({ backend: "native" });
    expect(handle?.isCurrent()).toBe(true);
    harness.close();
  });

  it("fails closed after the bounded retry also observes a config replacement", async () => {
    const firstProbe = deferred<{ codex: boolean; workspaceBash: boolean }>();
    const secondProbe = deferred<{ codex: boolean; workspaceBash: boolean }>();
    const capabilityProbe = vi.fn()
      .mockImplementationOnce(() => firstProbe.promise)
      .mockImplementationOnce(() => secondProbe.promise);
    const harness = createRuntimeHarness(capabilityProbe);
    const handlePromise = harness.runtime.resolveProviderBashHandle(
      adminPrivateIncoming(harness.config),
      undefined
    );
    await vi.waitFor(() => expect(capabilityProbe).toHaveBeenCalledTimes(1));

    const configB = structuredClone(harness.runtime.config);
    configB.bot.bash.adminPrivateBackend = "docker";
    harness.runtime.config = configB;
    firstProbe.resolve({ codex: true, workspaceBash: true });
    await vi.waitFor(() => expect(capabilityProbe).toHaveBeenCalledTimes(2));

    const configC = structuredClone(configB);
    configC.persona.agentWorkspace = "/tmp/sunabot-bash-wiring-runtime-c";
    harness.runtime.config = configC;
    secondProbe.resolve({ codex: true, workspaceBash: true });

    await expect(handlePromise).resolves.toBeUndefined();
    expect(capabilityProbe).toHaveBeenCalledTimes(2);
    expect(harness.auditPort.available).toHaveBeenCalledTimes(2);
    expect(harness.auditPort.run).not.toHaveBeenCalled();
    expect(runWorkspaceBashMock).not.toHaveBeenCalled();
    harness.close();
  });

  it("rejects an old handle before either its audit closure or sandbox can run", async () => {
    const harness = createRuntimeHarness();
    const handle = await harness.runtime.resolveProviderBashHandle(
      adminPrivateIncoming(harness.config),
      undefined
    );
    const executor = new RegistryProviderToolExecutor();
    const options = { bash: handle } satisfies ProviderCompleteOptions;
    const definitions = executor.resolveDefinitions(options);
    vi.mocked(harness.auditPort.run).mockClear();

    const nextConfig = structuredClone(harness.runtime.config);
    nextConfig.bot.bash.adminPrivateBackend = "docker";
    harness.runtime.config = nextConfig;

    expect(handle?.isCurrent()).toBe(false);
    await expect(handle!.audit({
      command: "pwd",
      backend: "native",
      accessMode: "admin",
      strictMode: true
    })).rejects.toThrow("BASH_AUDIT_UNAVAILABLE");
    const [output] = await executor.execute(
      [bashCall({ command: "pwd", timeoutMs: null })],
      options,
      definitions
    );
    expect(JSON.parse(String(output?.output))).toEqual({ ok: false, error: "Bash is not enabled." });
    expect(harness.auditPort.run).not.toHaveBeenCalled();
    expect(runWorkspaceBashMock).not.toHaveBeenCalled();
    harness.close();
  });

  it("does not return a handle when the isolation capability is unavailable", async () => {
    const capabilityProbe = vi.fn(async () => ({ codex: true, workspaceBash: false }));
    const harness = createRuntimeHarness(capabilityProbe);

    await expect(harness.runtime.resolveProviderBashHandle(
      adminPrivateIncoming(harness.config),
      undefined
    )).resolves.toBeUndefined();
    expect(harness.auditPort.available).toHaveBeenCalledTimes(1);
    expect(capabilityProbe).toHaveBeenCalledTimes(1);
    harness.close();
  });

  it("preserves a workbench capability failure in the runtime status", async () => {
    const capabilityProbe = vi.fn(async () => ({
      codex: true,
      workspaceBash: false,
      workspaceBashReason: "BASH_WORKBENCH_UNAVAILABLE" as const
    }));
    const harness = createRuntimeHarness(capabilityProbe);

    await expect(harness.runtime.resolveToolCapabilities()).resolves.toEqual({
      workspaceBash: false,
      workspaceBashReason: "BASH_WORKBENCH_UNAVAILABLE",
      codex: true
    });
    harness.close();
  });

  it("rejects a stale handle after the post-audit filesystem await without probing or spawning", async () => {
    bashToolMockState.runActual = true;
    const agentWorkspace = await makeAgentWorkspace("filesystem-race");
    const workbench = path.join(agentWorkspace, "workbench");
    await fs.mkdir(workbench);
    await fs.writeFile(path.join(workbench, "report.txt"), "safe");
    let epoch = 1;
    let armFilesystemRace = false;
    const probe = vi.fn(async () => undefined);
    const originalLstat = fs.lstat.bind(fs);
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (armFilesystemRace) {
        armFilesystemRace = false;
        await new Promise<void>((resolve) => setImmediate(() => {
          epoch = 2;
          resolve();
        }));
      }
      return originalLstat(...args as Parameters<typeof fs.lstat>);
    });

    try {
      const result = await runWorkspaceBash(
        { command: "cat report.txt", timeoutMs: null },
        agentWorkspace,
        {
          backend: "native",
          accessMode: "restricted",
          isCurrent: () => epoch === 1,
          audit: async () => {
            armFilesystemRace = true;
            return allowedAudit();
          },
          sandbox: nativeSandbox(probe)
        }
      );

      expect(result.stderr).toContain("BASH_CONFIGURATION_STALE");
      expect(JSON.stringify(result)).not.toContain(agentWorkspace);
      expect(probe).not.toHaveBeenCalled();
      expect(processState.calls).toHaveLength(0);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("allows an in-flight isolation probe to finish but rejects before spawning", async () => {
    bashToolMockState.runActual = true;
    const agentWorkspace = await makeAgentWorkspace("isolation-race");
    let epoch = 1;
    const probe = vi.fn(async () => { epoch = 2; });

    const result = await runWorkspaceBash({ command: "pwd", timeoutMs: null }, agentWorkspace, {
      backend: "native",
      accessMode: "admin",
      isCurrent: () => epoch === 1,
      audit: async () => allowedAudit(),
      sandbox: nativeSandbox(probe)
    });

    expect(result.stderr).toContain("BASH_CONFIGURATION_STALE");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(processState.calls).toHaveLength(0);
  });

  it("does not issue or consume approval when the confirmed path verification turns stale", async () => {
    bashToolMockState.runActual = true;
    const agentWorkspace = await makeAgentWorkspace("approval-race");
    const outsideFile = path.join(agentWorkspace, "outside.txt");
    await fs.writeFile(outsideFile, "approved");
    const command = `cat ${outsideFile}`;
    const store = new BashApprovalStore(() => 1_000, 60_000);
    const approvalContext = {
      agentId: "plana",
      accountId: "primary",
      transport: "onebot",
      conversationId: "private:admin",
      userId: "admin"
    };
    const confirmAudit = () => ({
      decision: "confirm" as const,
      risk: "medium" as const,
      outsideWorkbench: true,
      outsideAccesses: [{ path: outsideFile, access: "read" as const }],
      violations: [],
      summary: "outside read"
    });
    const pending = await runWorkspaceBash({ command, timeoutMs: null }, agentWorkspace, {
      isCurrent: () => true,
      audit: async () => confirmAudit(),
      approvalContext,
      approvalStore: store
    });
    expect(pending.approvalRequired).toBe(true);
    processState.calls = [];

    let epoch = 1;
    let armFilesystemRace = false;
    const probe = vi.fn(async () => undefined);
    const issue = vi.spyOn(store, "issue");
    const consume = vi.spyOn(store, "consume");
    const originalLstat = fs.lstat.bind(fs);
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      if (armFilesystemRace) {
        armFilesystemRace = false;
        await new Promise<void>((resolve) => setImmediate(() => {
          epoch = 2;
          resolve();
        }));
      }
      return originalLstat(...args as Parameters<typeof fs.lstat>);
    });

    try {
      const result = await runWorkspaceBash({ command, timeoutMs: null }, agentWorkspace, {
        isCurrent: () => epoch === 1,
        audit: async () => {
          armFilesystemRace = true;
          return confirmAudit();
        },
        approvalContext,
        approvalStore: store,
        confirmedApprovalId: pending.approvalId,
        sandbox: nativeSandbox(probe)
      });

      expect(result.stderr).toContain("BASH_CONFIGURATION_STALE");
      expect(issue).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      expect(processState.calls).toHaveLength(0);
    } finally {
      lstatSpy.mockRestore();
      issue.mockRestore();
      consume.mockRestore();
    }
  });

  it("treats an isCurrent getter exception as stale before audit, probe, or spawn", async () => {
    bashToolMockState.runActual = true;
    const audit = vi.fn(async () => allowedAudit());
    const probe = vi.fn(async () => undefined);

    const result = await runWorkspaceBash(
      { command: "pwd", timeoutMs: null },
      await makeAgentWorkspace("getter-throw"),
      {
        isCurrent: () => { throw new Error("getter failed"); },
        audit,
        sandbox: nativeSandbox(probe)
      }
    );

    expect(result.stderr).toContain("BASH_CONFIGURATION_STALE");
    expect(audit).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    expect(processState.calls).toHaveLength(0);
  });
});

function createRuntimeHarness(capabilityResolver?: RuntimeToolCapabilityResolver) {
  const config = createAdminTestConfig("/tmp/sunabot-bash-wiring-runtime");
  const capabilityProbe = capabilityResolver ?? vi.fn(async () => ({ codex: true, workspaceBash: true }));
  const auditPort: RuntimeBashAuditPort = {
    available: vi.fn(async () => true),
    run: vi.fn(async () => allowedAudit())
  };
  const store = new SessionStore({ databasePath: ":memory:" });
  const runtime = new SunaRuntime(config, {
    attachmentService: {} as never,
    sessionStore: store,
    resolveToolCapabilities: capabilityProbe,
    bashAudit: auditPort
  });
  return { config, runtime, capabilityProbe: vi.mocked(capabilityProbe), auditPort, close: () => runtime.close() };
}

function adminPrivateIncoming(
  config: AppConfig,
  overrides: Partial<ParsedIncomingMessage> & { senderId?: string } = {}
): ParsedIncomingMessage {
  const userId = overrides.userId ?? Number(config.bot.adminQq);
  const senderId = overrides.senderId ?? String(userId);
  const { senderId: _senderId, ...incomingOverrides } = overrides;
  return {
    schemaVersion: 1,
    agentId: config.persona.defaultAgentId,
    accountId: "primary",
    scope: "private",
    messageId: 1001,
    selfId: 10000,
    time: "2026-07-17T00:00:00.000Z",
    userId,
    sender: { id: senderId },
    text: "pwd",
    media: [],
    attachments: [],
    replyMessageIds: [],
    quoteReferences: [],
    mentionedSelf: false,
    ...incomingOverrides
  };
}

function adminGroupIncoming(
  config: AppConfig,
  overrides: Partial<ParsedIncomingMessage> & { senderId?: string } = {}
): ParsedIncomingMessage {
  return {
    ...adminPrivateIncoming(config, overrides),
    scope: "user_group",
    groupId: 30003
  };
}

const negativeCases: Array<{
  name: string;
  incomingFor: (config: AppConfig) => ParsedIncomingMessage;
  promptOverride?: string;
  configure?: (config: AppConfig) => void;
}> = [
  { name: "a prompt override", incomingFor: (config) => adminPrivateIncoming(config), promptOverride: "" },
  { name: "a message without messageId", incomingFor: (config) => adminPrivateIncoming(config, { messageId: undefined }) },
  { name: "a message without selfId", incomingFor: (config) => adminPrivateIncoming(config, { selfId: undefined }) },
  { name: "a message without sender", incomingFor: (config) => adminPrivateIncoming(config, { sender: undefined }) },
  { name: "an invalid QQ sender", incomingFor: (config) => adminPrivateIncoming(config, { userId: 1, senderId: "1" }) },
  { name: "Web Chat", incomingFor: (config) => adminPrivateIncoming(config, { transport: "web" }) },
  { name: "a message without account", incomingFor: (config) => adminPrivateIncoming(config, { accountId: undefined }) },
  { name: "a mismatched Agent", incomingFor: (config) => adminPrivateIncoming(config, { agentId: "other-agent" }) }
];

function bashCall(args: Record<string, unknown>) {
  return {
    type: "function_call" as const,
    name: "workspace_bash",
    call_id: "call-bash",
    arguments: JSON.stringify(args)
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function makeAgentWorkspace(prefix: string) {
  const root = await fs.mkdtemp(path.join(secureScratchParent, `.bash-wiring-${prefix}-`));
  temporaryRoots.push(root);
  return root;
}

function nativeSandbox(probe: () => Promise<void>) {
  return {
    platform: "linux" as const,
    effectiveUid: 1_000,
    executable: "/fixture/bwrap",
    resourceLimiter: "/fixture/prlimit",
    access: async () => undefined,
    probe: async () => probe()
  };
}

function allowedAudit(): BashAuditResult {
  return {
    decision: "allow",
    risk: "low",
    outsideWorkbench: false,
    outsideAccesses: [],
    violations: [],
    summary: "Allowed."
  };
}
