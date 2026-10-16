import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { readUserTestCaseDocument } from "../../tooling/user-test-harness/caseDocument.js";
import { prepareUserTestWorkspace } from "../../tooling/user-test-harness/workspace.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([false, true])("delivers a raw OneBot reply with over-capacity recording=%s", { timeout: 30_000 }, async (recordMemory) => {
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
  const existingContent = "已有评审记录😀".repeat(4_000);
  const recordedContent = "我会在明天下午三点前发送评审稿，发出前确认附件能打开。";
  const capacityErrors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const item = recordMemory && requests.length === 1 ? {
      type: "function_call", id: "fc_memory", call_id: "call_memory", status: "completed",
      name: "add_workmemory", arguments: JSON.stringify({ action: "record", content: recordedContent })
    } : {
      type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: recordMemory ? "已记住评审稿的发送时间和附件检查要求。" : "已收到" }]
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
    const prepared = await prepareUserTestWorkspace({ source, destination, confirmCredentialCopy: true });
    process.env.SUNABOT_WORKSPACE = destination;
    process.env.SUNABOT_USER_TEST_TIMEOUT_MS = "5000";
    vi.resetModules();
    const document = await readUserTestCaseDocument(path.resolve(recordMemory
      ? "docs/user-tests/add-workmemory-direct-write.md" : "docs/user-tests/llm-permissive-content.md"));
    if (recordMemory && document.case.kind === "conversation") {
      document.case.input.fixture = {
        workingMemory: [{ id: "large-existing", content: existingContent,
          occurredAt: "2026-08-29T08:00:00.000Z",
          conversationId: "private:10001", conversationScope: "private" }],
        longTerm: [], userProfiles: []
      };
    }
    const { runRuntimeUserTest } = await import("../../tooling/user-test-harness/runtimeDriver.js");
    const report = await runRuntimeUserTest(document.case, document.digest);
    expect(report.execution.status, JSON.stringify(report.execution)).toBe("passed");
    expect(report.execution.assertions.every((assertion) => assertion.passed)).toBe(true);
    if (!recordMemory) expect(report.observation.toolCalls).toEqual([]);
    expect(JSON.stringify(report.observation.outbound)).toContain(recordMemory ? "已记住评审稿" : "已收到");
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.tool_choice == null || request.tool_choice === "auto")).toBe(true);
    const { readWorkingMemoryDocument } = await import("../../services/memory/workingMemoryDocument.js");
    const { loadConfig } = await import("../../src/config.js");
    const sharedConfig = await loadConfig();
    const memory = await readWorkingMemoryDocument({
      ...sharedConfig,
      persona: { ...sharedConfig.persona, defaultAgentId: prepared.agentId,
        agentWorkspace: path.join(destination, "business/agents", prepared.agentId) }
    });
    if (recordMemory) {
      expect(memory.items.map((item) => item.content)).toEqual([existingContent, recordedContent]);
      expect(memory.items[0]?.id).toBe("large-existing");
      expect(Buffer.byteLength(memory.content, "utf8")).toBeGreaterThan(65_536);
      expect(memory.capacityWarning).toMatchObject({ code: "WORKING_MEMORY_TOO_LARGE", blocking: false });
      expect(capacityErrors).toHaveBeenCalledWith("[working-memory] capacity exceeded", expect.objectContaining({ blocking: false }));
      expect(JSON.stringify(requests)).toContain("WORKING_MEMORY_TOO_LARGE");
      expect(JSON.stringify(requests)).toContain("工作记忆已记录");
      expect(report.observation.requestLogs).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "working.capacity_check", response: expect.objectContaining({
          outcome: "failed", capacityError: expect.objectContaining({ blocking: false })
        }) })
      ]));
    } else expect(memory.items).toEqual([]);
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
