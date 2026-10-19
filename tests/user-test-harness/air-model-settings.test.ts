import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { readUserTestCaseDocument } from "../../tooling/user-test-harness/caseDocument.js";
import { prepareUserTestWorkspace } from "../../tooling/user-test-harness/workspace.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["", "air-model"])("routes raw OneBot AIR updates with airModel=%s", { timeout: 30_000 }, async (airModel) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-air-ingress-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  const previousWorkspace = process.env.SUNABOT_WORKSPACE;
  const previousTimeout = process.env.SUNABOT_USER_TEST_TIMEOUT_MS;
  const config = defaultConfig();
  config.bot.replyModel = "reply-model";
  config.bot.airModel = airModel;
  config.bot.replyDebounceMs = 0;
  config.bot.orchestrator.enabled = false;
  config.bot.tone.enabled = false;
  config.persona.defaultAgentId = "koharu";
  config.persona.agentWorkspace = "workspace/business/agents/koharu";
  config.providers = { defaultProviderId: "fixture-provider", items: [{
    ...config.providers.items[0]!, id: "fixture-provider", label: "Fixture Provider",
    kind: "codex-responses", model: "rejected-default-model",
    baseUrl: "https://provider.fixture.invalid", apiKeyEnv: "FIXTURE_PROVIDER_KEY",
    envFile: "workspace/secrets/runtime.env"
  }] };
  const models: string[] = [];
  const air = "# 互动约定\n\n当前私聊：回答保持简洁，称呼用户为林老师。";
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    models.push(request.model);
    if (request.model === "rejected-default-model") return new Response("unsupported model", { status: 400 });
    const item = models.length === 1 ? {
      type: "function_call", id: "fc_air", call_id: "call_air", status: "completed",
      name: "read_air", arguments: JSON.stringify({ insight: "当前私聊称呼用户为林老师，保留回答简洁的约定。" })
    } : {
      type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: models.length === 2 ? air : "林老师，记住了。" }]
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
    await fs.mkdir(path.join(source, "business/agents/koharu"), { recursive: true });
    await fs.mkdir(path.join(source, "secrets"), { recursive: true });
    await fs.writeFile(path.join(source, "business/config/sunabot.json"), JSON.stringify(config));
    await fs.writeFile(path.join(source, "secrets/runtime.env"), "FIXTURE_PROVIDER_KEY=fixture-token\n");
    const prepared = await prepareUserTestWorkspace({ source, destination, confirmCredentialCopy: true });
    process.env.SUNABOT_WORKSPACE = destination;
    process.env.SUNABOT_USER_TEST_TIMEOUT_MS = "5000";
    vi.resetModules();
    const document = await readUserTestCaseDocument(path.resolve("docs/user-tests/cases/admin-console/air-model-settings.md"));
    const { runRuntimeUserTest } = await import("../../tooling/user-test-harness/runtimeDriver.js");
    const report = await runRuntimeUserTest(document.case, document.digest);
    expect(report.execution.status, JSON.stringify(report.execution)).toBe("passed");
    expect(report.execution.assertions.every((assertion) => assertion.passed)).toBe(true);
    expect(models).toEqual(["reply-model", airModel || "reply-model", "reply-model"]);
    expect((await fs.readFile(path.join(destination, "business/agents", prepared.agentId, "AIR.md"), "utf8")).trim()).toBe(air);
    await fs.mkdir("test-results/air-model", { recursive: true });
    await fs.writeFile(`test-results/air-model/${airModel || "follow"}.json`, JSON.stringify(report, null, 2));
  } finally {
    if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
    else process.env.SUNABOT_WORKSPACE = previousWorkspace;
    if (previousTimeout == null) delete process.env.SUNABOT_USER_TEST_TIMEOUT_MS;
    else process.env.SUNABOT_USER_TEST_TIMEOUT_MS = previousTimeout;
    vi.resetModules();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
