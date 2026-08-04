import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config.js";
import { readUserTestCaseDocument } from "../../tooling/user-test-harness/caseDocument.js";
import { prepareUserTestWorkspace } from "../../tooling/user-test-harness/workspace.js";

describe("QQ private PDF attachment user test", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes the raw private file event through its receiving account and exposes parsed PDF text", {
    timeout: 30_000
  }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-user-test-private-pdf-"));
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
    const providerRequestBodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      const requestBody = String(init?.body ?? "");
      providerRequestBodies.push(requestBody);
      const parsed = JSON.parse(requestBody) as {
        tool_choice?: { name?: unknown; function?: { name?: unknown } };
      };
      const requiredTool = parsed.tool_choice?.name
        ?? parsed.tool_choice?.function?.name;
      if (requiredTool === "add_workmemory") {
        return codexSseResponse("", [{
          name: "add_workmemory",
          args: { action: "skip", content: null }
        }]);
      }
      if (requiredTool === "add_user_profile") {
        return codexSseResponse(
          "已成功读取文件：PDF-ATTACHMENT-ROUTING-OK-20260730",
          [{
            name: "add_user_profile",
            args: { action: "skip", profile: null, addressNames: null }
          }]
        );
      }
      return codexSseResponse("BLUE");
    }));
    try {
      await fs.mkdir(path.join(source, "business/config"), { recursive: true });
      await fs.mkdir(path.join(source, "business/agents/koharu"), {
        recursive: true,
        mode: 0o700
      });
      await fs.mkdir(path.join(source, "secrets"), { recursive: true });
      await fs.writeFile(
        path.join(source, "business/config/sunabot.json"),
        JSON.stringify(config)
      );
      await fs.writeFile(
        path.join(source, "secrets/runtime.env"),
        "FIXTURE_PROVIDER_KEY=fixture-token\n"
      );
      await prepareUserTestWorkspace({
        source,
        destination,
        confirmCredentialCopy: true
      });
      process.env.SUNABOT_WORKSPACE = destination;
      process.env.SUNABOT_USER_TEST_TIMEOUT_MS = "5000";
      vi.resetModules();
      const [document, { runRuntimeUserTest }] = await Promise.all([
        readUserTestCaseDocument(path.resolve("docs/user-tests/qq-private-pdf-attachment.md")),
        import("../../tooling/user-test-harness/runtimeDriver.js")
      ]);
      const report = await runRuntimeUserTest(document.case, document.digest);

      expect(
        report.execution.status,
        JSON.stringify({
          execution: report.execution,
          observation: report.observation
        }, null, 2)
      ).toBe("passed");
      expect(report.execution.assertions.every((assertion) => assertion.passed)).toBe(true);
      expect(report.observation.attachmentResolutions).toEqual([
        expect.objectContaining({
          accountId: "fixture-secondary",
          fileId: "fixture-private-pdf",
          strategy: "resolve",
          outcome: "resolved"
        })
      ]);
      expect(report.observation.inboundAttachments).toEqual([
        expect.objectContaining({
          messageId: "885282519",
          index: 0,
          status: "ready",
          format: "pdf",
          pageCount: 1,
          handle: "message:885282519:file:0"
        })
      ]);
      expect(providerRequestBodies.join("\n"))
        .toContain("PDF-ATTACHMENT-ROUTING-OK-20260730");
      expect(JSON.stringify(report.observation.outbound))
        .toContain("PDF-ATTACHMENT-ROUTING-OK-20260730");
    } finally {
      if (previousWorkspace == null) delete process.env.SUNABOT_WORKSPACE;
      else process.env.SUNABOT_WORKSPACE = previousWorkspace;
      if (previousTimeout == null) delete process.env.SUNABOT_USER_TEST_TIMEOUT_MS;
      else process.env.SUNABOT_USER_TEST_TIMEOUT_MS = previousTimeout;
      vi.resetModules();
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50
      });
    }
  });
});

function codexSseResponse(
  text: string,
  calls: Array<{ name: string; args: Record<string, unknown> }> = []
) {
  const output = [{
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text }]
  }, ...calls.map((call, index) => ({
    type: "function_call",
    name: call.name,
    call_id: `fixture-call-${index}-${call.name}`,
    arguments: JSON.stringify(call.args),
    status: "completed"
  }))];
  const events = output.map((item, outputIndex) => ({
    type: "response.output_item.done",
    output_index: outputIndex,
    item
  }));
  events.push({
    type: "response.completed",
    response: { status: "completed", output }
  } as never);
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    }
  );
}
