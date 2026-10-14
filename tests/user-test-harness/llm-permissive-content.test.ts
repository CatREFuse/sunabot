import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { readUserTestCaseDocument } from "../../tooling/user-test-harness/caseDocument.js";
import { prepareUserTestWorkspace } from "../../tooling/user-test-harness/workspace.js";

afterEach(() => vi.unstubAllGlobals());

it("delivers a raw OneBot reply without forced memory decisions", { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-permissive-harness-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const previousWorkspace = process.env.SUNABOT_WORKSPACE;
  const previousTimeout = process.env.SUNABOT_USER_TEST_TIMEOUT_MS;
  const config = defaultConfig();
  config.bot.replyDebounceMs = 0;
  config.bot.orchestrator.enabled = false;
  config.bot.tone.enabled = false;
  config.persona.defaultAgentId = "koharu";
  config.persona.agentWorkspace = "workspace/business/agents/koharu";
  config.providers = {
    defaultProviderId: "fixture-provider",
    items: [{
      ...config.providers.items[0]!,
      id: "fixture-provider",
      label: "Fixture Provider",
      kind: "codex-responses",
      model: "fixture-model",
      baseUrl: "https://provider.fixture.invalid",
      apiKeyEnv: "FIXTURE_PROVIDER_KEY",
      envFile: "workspace/secrets/runtime.env"
    }]
  };
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const item = {
      type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "已收到" }]
    };
    return new Response([
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { status: "completed", output: [item] } }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200, headers: { "content-type": "text/event-stream" }
    });
  }));
  try {
    await fs.mkdir(path.join(source, "business/config"), { recursive: true });
    await fs.mkdir(path.join(source, "business/agents/koharu"), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(source, "secrets"), { recursive: true });
    await fs.writeFile(path.join(source, "business/config/sunabot.json"), JSON.stringify(config));
    await fs.writeFile(path.join(source, "secrets/runtime.env"), "FIXTURE_PROVIDER_KEY=fixture-token\n");
    await prepareUserTestWorkspace({ source, destination, confirmCredentialCopy: true });
    process.env.SUNABOT_WORKSPACE = destination;
    process.env.SUNABOT_USER_TEST_TIMEOUT_MS = "5000";
    vi.resetModules();
    const document = await readUserTestCaseDocument(path.resolve("docs/user-tests/llm-permissive-content.md"));
    const { runRuntimeUserTest } = await import("../../tooling/user-test-harness/runtimeDriver.js");
    const report = await runRuntimeUserTest(document.case, document.digest);
    expect(report.execution.status, JSON.stringify(report.execution)).toBe("passed");
    expect(report.execution.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(report.observation.toolCalls).toEqual([]);
    expect(JSON.stringify(report.observation.outbound)).toContain("已收到");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.tool_choice == null || request.tool_choice === "auto")).toBe(true);
    const { readWorkingMemoryDocument } = await import("../../services/memory/workingMemoryDocument.js");
    const { loadConfig } = await import("../../src/config.js");
    const memory = await readWorkingMemoryDocument(await loadConfig());
    expect(memory.items).toEqual([]);
    console.info("LLM_PERMISSIVE_HARNESS", JSON.stringify({
      runId: report.runId,
      execution: report.execution,
      outbound: report.observation.outbound,
      toolCalls: report.observation.toolCalls,
      workingMemoryItems: memory.items.length,
      requests: requests.length
    }));
  } finally {
    if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
    else process.env.SUNABOT_WORKSPACE = previousWorkspace;
    if (previousTimeout == null) delete process.env.SUNABOT_USER_TEST_TIMEOUT_MS;
    else process.env.SUNABOT_USER_TEST_TIMEOUT_MS = previousTimeout;
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
