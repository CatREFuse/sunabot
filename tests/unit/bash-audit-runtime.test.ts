// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";
import { createBashAuditRuntimePort } from "../../apps/api/bashAuditRuntime.js";

describe("independent Bash audit model runner", () => {
  it("uses the configured audit model with no conversation context, no tools, strict JSON, and the caller signal", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-bash-audit-runtime");
    config.bot.bash.auditModel = "gpt-5.4-mini-audit";
    const completeRequest = vi.fn(async () => JSON.stringify({
      decision: "allow",
      risk: "low",
      outsideWorkbench: false,
      outsideAccesses: [],
      violations: [],
      summary: "Allowed."
    }));
    const providerConfigs: ProviderConfig[] = [];
    const port = createBashAuditRuntimePort({
      createProvider(providerConfig) {
        providerConfigs.push(providerConfig);
        return { hasApiKey: () => true, completeRequest };
      }
    });
    const controller = new AbortController();

    await expect(port.available(config)).resolves.toBe(true);
    await expect(port.run(config, {
      command: "pwd",
      backend: "docker",
      accessMode: "admin",
      strictMode: true,
      signal: controller.signal
    })).resolves.toMatchObject({ decision: "allow" });

    expect(providerConfigs.at(-1)).toMatchObject({
      id: "test-provider:bash-audit",
      model: "gpt-5.4-mini-audit",
      enabled: true
    });
    expect(completeRequest).toHaveBeenCalledOnce();
    const [request, options] = completeRequest.mock.calls[0]!;
    expect(request.tools).toEqual([]);
    expect(request.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "bash_security_audit", strict: true }
    });
    expect(request.messages).toHaveLength(2);
    expect(request.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
    expect(JSON.stringify(request)).not.toContain("conversationId");
    expect(options).toMatchObject({
      signal: controller.signal,
      modelRequestMaxRetries: 0,
      logContext: { stage: "bash_audit", promptFamily: "bash_audit" }
    });
  });

  it("fails availability closed for a disabled Provider or missing API key", async () => {
    const config = createAdminTestConfig("/tmp/sunabot-bash-audit-unavailable");
    config.providers.items[0]!.enabled = false;
    const createProvider = vi.fn(() => ({
      hasApiKey: () => false,
      completeRequest: vi.fn(async () => "must-not-run")
    }));
    const port = createBashAuditRuntimePort({ createProvider });

    await expect(port.available(config)).resolves.toBe(false);
    await expect(port.run(config, {
      command: "pwd",
      backend: "docker",
      accessMode: "admin",
      strictMode: true
    })).rejects.toThrow("BASH_AUDIT_UNAVAILABLE");
    expect(createProvider).not.toHaveBeenCalled();

    config.providers.items[0]!.enabled = true;
    await expect(port.available(config)).resolves.toBe(false);
    expect(createProvider).toHaveBeenCalledOnce();
  });
});
