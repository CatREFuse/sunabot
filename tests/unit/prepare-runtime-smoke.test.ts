// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RegistryProviderToolExecutor } from "../../adapters/model/provider/toolExecutor.js";
import { WORKSPACE_LAYOUT } from "../../packages/platform/workspaceLayout.js";
import { defaultConfig } from "../../src/config.js";
import {
  assertProviderRouteLockDocuments,
  prepareProviderSmokeWorkspace,
  providerRouteLockFieldPaths
} from "../../tooling/quality/prepare-runtime-smoke.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("prepare provider smoke workspace", () => {
  it("copies only the selected provider credential into the new layout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await write(path.join(source, "config/sunabot.json"), JSON.stringify({
      server: { host: "0.0.0.0", port: 8787 },
      persona: { defaultAgentId: "plana", agentWorkspace: "workspace/agents/plana" },
      providers: {
        defaultProviderId: "selected",
        items: [
          { id: "selected", kind: "openai-official", model: "test-model", apiKeyEnv: "SELECTED_KEY", envFile: "workspace/.env", enabled: true },
          { id: "unused", kind: "openai-official", model: "unused", apiKeyEnv: "UNUSED_KEY", enabled: true }
        ]
      },
      bot: { adminQq: "171419991" },
      onebot: { reverseWsPath: "/onebot/v11/ws", accessTokenEnv: "ONEBOT_ACCESS_TOKEN" }
    }));
    await write(path.join(source, ".env"), "SELECTED_KEY=selected-secret\nUNUSED_KEY=must-not-copy\nBARK_URL=must-not-copy\n");
    await write(path.join(source, "agents/plana/AGENTS.md"), "test agent\n");

    const result = await prepareProviderSmokeWorkspace({ source, destination, confirmCredentialCopy: true });
    const config = JSON.parse(await fs.readFile(result.configPath, "utf8"));
    const environment = await fs.readFile(result.envPath, "utf8");
    expect(config.server).toEqual({ host: "127.0.0.1", port: 18_876 });
    expect(config.persona.agentWorkspace).toBe("workspace/business/agents/plana");
    expect(config.providers.items).toHaveLength(1);
    expect(config.providers.items[0].envFile).toBe("workspace/secrets/runtime.env");
    expect(environment).toContain("SELECTED_KEY=");
    expect(environment).toContain("ONEBOT_ACCESS_TOKEN=");
    expect(environment).not.toContain("must-not-copy");
    await expect(fs.readFile(path.join(destination, "business/agents/plana/AGENTS.md"), "utf8"))
      .resolves.toBe("test agent\n");
  });

  it("refuses an external provider credential path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-external-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const external = path.join(root, "external.env");
    await write(external, "KEY=secret\n");
    await write(path.join(source, "config/sunabot.json"), JSON.stringify({
      providers: { defaultProviderId: "selected", items: [{ id: "selected", apiKeyEnv: "KEY", envFile: external }] }
    }));

    await expect(prepareProviderSmokeWorkspace({ source, destination, confirmCredentialCopy: true }))
      .rejects.toThrow(/不在源 workspace/);
  });

  it("converts a workspace-contained Codex login into the isolated token variable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-codex-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await write(path.join(source, "config/sunabot.json"), JSON.stringify({
      persona: { agentWorkspace: "workspace/agents/plana" },
      providers: {
        defaultProviderId: "codex",
        items: [{ id: "codex", kind: "codex-responses", model: "gpt-test", apiKeyEnv: "CODEX_ACCESS_TOKEN", envFile: ".env", enabled: true }]
      },
      bot: { adminQq: "171419991" },
      onebot: { reverseWsPath: "/onebot/v11/ws", accessTokenEnv: "ONEBOT_ACCESS_TOKEN" }
    }));
    await write(path.join(source, ".env"), "OPEN_ARONA_CODEX_AUTH_FILE=workspace/security/codex/auth.json\n");
    await write(path.join(source, "security/codex/auth.json"), JSON.stringify({
      tokens: { access_token: "codex-test-access-token" }
    }));

    const result = await prepareProviderSmokeWorkspace({ source, destination, confirmCredentialCopy: true });
    const environment = await fs.readFile(result.envPath, "utf8");
    expect(environment).toContain("CODEX_ACCESS_TOKEN=");
    expect(environment).toContain("codex-test-access-token");
    expect(environment).not.toContain("OPEN_ARONA_CODEX_AUTH_FILE");
  });

  it("copies the standard Codex auth file exactly only with the locked opt-in", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-codex-auth-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const defaultDestination = path.join(root, "default-destination");
    const copiedDestination = path.join(root, "copied-destination");
    const authContent = `${JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "codex-app-server-access-token",
        refresh_token: "codex-app-server-refresh-token"
      }
    }, null, 2)}\n`;
    await writeRouteLockSource(source, "codex-responses");
    await write(codexAuthPath(source), authContent);

    const defaultResult = await prepareProviderSmokeWorkspace({
      source,
      destination: defaultDestination,
      confirmCredentialCopy: true,
      providerId: "selected",
      model: "gpt-5.6-sol",
      lockProviderRoutes: true
    });
    expect(defaultResult.codexAuthCopied).toBe(false);
    await expect(fs.access(codexAuthPath(defaultDestination)))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readdir(path.dirname(codexAuthPath(defaultDestination))))
      .resolves.toEqual([]);

    const copiedResult = await prepareProviderSmokeWorkspace({
      source,
      destination: copiedDestination,
      confirmCredentialCopy: true,
      providerId: "selected",
      model: "gpt-5.6-sol",
      lockProviderRoutes: true,
      copyCodexAuth: true
    });
    expect(copiedResult.codexAuthCopied).toBe(true);
    await expect(fs.readFile(codexAuthPath(copiedDestination), "utf8"))
      .resolves.toBe(authContent);
    const copiedStats = await fs.lstat(codexAuthPath(copiedDestination));
    expect(copiedStats.isFile()).toBe(true);
    expect(copiedStats.isSymbolicLink()).toBe(false);
    expect(copiedStats.nlink).toBe(1);
    expect(copiedStats.mode & 0o777).toBe(0o600);
    await expect(fs.readdir(path.dirname(codexAuthPath(copiedDestination))))
      .resolves.toEqual(["auth.json"]);
    const environmentNames = (await fs.readFile(copiedResult.envPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.slice(0, line.indexOf("=")))
      .sort();
    expect(environmentNames).toEqual(["ONEBOT_ACCESS_TOKEN", "SELECTED_KEY"]);
  });

  it("requires a locked Codex route before copying Codex auth", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-codex-auth-lock-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await writeRouteLockSource(source, "codex-responses");
    await write(codexAuthPath(source), JSON.stringify({
      tokens: { access_token: "codex-access-token" }
    }));

    await expect(prepareProviderSmokeWorkspace({
      source,
      destination,
      confirmCredentialCopy: true,
      copyCodexAuth: true
    })).rejects.toThrow("USER_TEST_CODEX_AUTH_ROUTE_LOCK_REQUIRED");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects symlinked and multiply-linked Codex auth files and clears the destination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-codex-auth-link-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const symlinkDestination = path.join(root, "symlink-destination");
    const hardlinkDestination = path.join(root, "hardlink-destination");
    const sourceAuth = codexAuthPath(source);
    const sourceAuthTarget = path.join(path.dirname(sourceAuth), "source-auth.json");
    await writeRouteLockSource(source, "codex-responses");
    await write(sourceAuthTarget, JSON.stringify({
      tokens: { access_token: "codex-access-token" }
    }));
    await fs.symlink("source-auth.json", sourceAuth);

    await expect(prepareProviderSmokeWorkspace({
      source,
      destination: symlinkDestination,
      confirmCredentialCopy: true,
      providerId: "selected",
      model: "gpt-5.6-sol",
      lockProviderRoutes: true,
      copyCodexAuth: true
    })).rejects.toThrow("USER_TEST_CODEX_AUTH_SOURCE_INVALID");
    await expect(fs.access(symlinkDestination)).rejects.toMatchObject({ code: "ENOENT" });

    await fs.unlink(sourceAuth);
    await fs.link(sourceAuthTarget, sourceAuth);
    await expect(prepareProviderSmokeWorkspace({
      source,
      destination: hardlinkDestination,
      confirmCredentialCopy: true,
      providerId: "selected",
      model: "gpt-5.6-sol",
      lockProviderRoutes: true,
      copyCodexAuth: true
    })).rejects.toThrow("USER_TEST_CODEX_AUTH_SOURCE_INVALID");
    await expect(fs.access(hardlinkDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["malformed JSON", "{", "USER_TEST_CODEX_AUTH_JSON_INVALID"],
    [
      "missing access token",
      JSON.stringify({ tokens: { refresh_token: "refresh-only" } }),
      "USER_TEST_CODEX_AUTH_ACCESS_TOKEN_REQUIRED"
    ]
  ])("rejects %s in the Codex auth file and clears the destination", async (
    _label,
    authContent,
    errorCode
  ) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-codex-auth-invalid-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await writeRouteLockSource(source, "codex-responses");
    await write(codexAuthPath(source), authContent);

    await expect(prepareProviderSmokeWorkspace({
      source,
      destination,
      confirmCredentialCopy: true,
      providerId: "selected",
      model: "gpt-5.6-sol",
      lockProviderRoutes: true,
      copyCodexAuth: true
    })).rejects.toThrow(errorCode);
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a partially written destination when a custom Agent copy fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-copy-failure-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await write(path.join(source, "config/sunabot.json"), JSON.stringify({
      persona: { defaultAgentId: "plana", agentWorkspace: "workspace/agents/plana" },
      providers: {
        defaultProviderId: "selected",
        items: [{
          id: "selected",
          kind: "openai-official",
          model: "test-model",
          apiKeyEnv: "SELECTED_KEY",
          envFile: "workspace/.env",
          enabled: true
        }]
      }
    }));
    await write(path.join(source, ".env"), "SELECTED_KEY=selected-secret\n");
    await write(path.join(source, "agents/plana/AGENTS.md"), "test agent\n");

    await expect(prepareProviderSmokeWorkspace({
      source,
      destination,
      confirmCredentialCopy: true,
      copyAgentWorkspace: async ({ destination: agentDestination }: {
        destination: string;
      }) => {
        await write(
          path.join(agentDestination, "runtime/private-production-state.json"),
          "must be removed"
        );
        throw new Error("FIXTURE_AGENT_COPY_FAILED");
      }
    })).rejects.toThrow("FIXTURE_AGENT_COPY_FAILED");
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("locks every declared shared and Agent route to one Codex provider and model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-lock-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const offRouteBot = routeBot("other-provider", "other-model");
    offRouteBot.tools.generateImg = {
      provider: "preserved-image-tool",
      size: "1024x1024",
      resolution: "1K",
      quality: "high"
    };
    offRouteBot.tools.websearch = {
      provider: "tavily",
      tavilyApiKey: "shared-inline-secret",
      tavilyApiKeys: ["shared-inline-secret-2"],
      tavilyApiKeyEnv: "TAVILY_API_KEY",
      maxResults: 5
    };
    await write(path.join(source, "config/sunabot.json"), JSON.stringify({
      persona: { defaultAgentId: "plana", agentWorkspace: "workspace/agents/plana" },
      providers: {
        defaultProviderId: "other-provider",
        items: [{
          id: "other-provider",
          kind: "openai-official",
          model: "other-model",
          imageModel: "keep-other-image-model",
          apiKeyEnv: "OTHER_KEY",
          envFile: "workspace/.env"
        }, {
          id: "selected-codex",
          kind: "codex-responses",
          model: "source-model",
          imageModel: "keep-selected-image-model",
          baseUrl: "https://attacker.invalid/codex",
          apiKeyEnv: "CODEX_KEY",
          apiKey: "selected-inline-secret",
          envFile: "workspace/.env"
        }]
      },
      bot: offRouteBot
    }));
    await write(path.join(source, ".env"), "OTHER_KEY=other-secret\nCODEX_KEY=selected-secret\n");
    await write(path.join(source, "agents/plana/agent.json"), JSON.stringify({
      schemaVersion: 1,
      id: "plana",
      providers: {
        defaultProviderId: "agent-only-provider",
        items: [{ id: "agent-only-provider", apiKey: "agent-provider-secret" }]
      },
      bot: {
        ...routeBot("agent-provider", "agent-model"),
        tools: {
          ...routeBot("agent-provider", "agent-model").tools,
          websearch: {
            tavilyApiKey: "agent-inline-secret",
            tavilyApiKeys: ["agent-inline-secret-2"],
            tavilyApiKeyEnv: "TAVILY_API_KEY"
          }
        }
      }
    }));

    const result = await prepareProviderSmokeWorkspace({
      source,
      destination,
      confirmCredentialCopy: true,
      providerId: "selected-codex",
      model: "gpt-5.6-sol",
      lockProviderRoutes: true
    });
    const config = JSON.parse(await fs.readFile(result.configPath, "utf8"));
    const agentConfigPath = path.join(destination, "business/agents/plana/agent.json");
    const agent = JSON.parse(await fs.readFile(agentConfigPath, "utf8"));
    expect(config.providers.defaultProviderId).toBe("selected-codex");
    expect(config.providers.items).toEqual([
      expect.objectContaining({
        id: "selected-codex",
        kind: "codex-responses",
        model: "gpt-5.6-sol",
        imageModel: "keep-selected-image-model",
        baseUrl: "https://chatgpt.com/backend-api/codex"
      })
    ]);
    expect(config.bot.tools.generateImg.provider).toBe("preserved-image-tool");
    expect(JSON.stringify(config)).not.toContain("inline-secret");
    expect(JSON.stringify(agent)).not.toContain("inline-secret");
    expect(agent).not.toHaveProperty("providers");
    expect(Object.keys(
      Object.fromEntries((await fs.readFile(result.envPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), true]))
    ).sort()).toEqual(["CODEX_KEY", "ONEBOT_ACCESS_TOKEN"]);
    expect(providerRouteLockFieldPaths()).toEqual([
      "bot.replyProviderId",
      "bot.replyModel",
      "bot.imageReader.providerId",
      "bot.imageReader.model",
      "bot.tone.providerId",
      "bot.tone.model",
      "bot.memory.memoryProviderId",
      "bot.memory.memoryModel",
      "bot.orchestrator.userGroupchatOrchestratorProviderId",
      "bot.orchestrator.userGroupchatOrchestratorModel",
      "bot.orchestrator.groupThreadProviderId",
      "bot.orchestrator.groupThreadModel",
      "bot.tools.codex.model",
      "bot.bash.auditModel"
    ]);
    for (const document of [config, agent]) {
      expectRouteLock(document, "selected-codex", "gpt-5.6-sol");
    }
    await expect(assertProviderRouteLockDocuments({
      configPath: result.configPath,
      agentConfigPath,
      envPath: result.envPath,
      providerId: "selected-codex",
      model: "gpt-5.6-sol",
      providerApiKeyEnv: "CODEX_KEY",
      onebotAccessTokenEnv: "ONEBOT_ACCESS_TOKEN"
    })).resolves.toBeUndefined();

    config.providers.items[0].baseUrl = "https://attacker.invalid/codex";
    await fs.writeFile(result.configPath, JSON.stringify(config), "utf8");
    await expect(assertProviderRouteLockDocuments({
      configPath: result.configPath,
      agentConfigPath,
      envPath: result.envPath,
      providerId: "selected-codex",
      model: "gpt-5.6-sol",
      providerApiKeyEnv: "CODEX_KEY",
      onebotAccessTokenEnv: "ONEBOT_ACCESS_TOKEN"
    })).rejects.toThrow(
      "USER_TEST_PROVIDER_ROUTE_LOCK_INVALID: shared.providers.items[0]"
    );
    config.providers.items[0].baseUrl = "https://chatgpt.com/backend-api/codex";
    await fs.writeFile(result.configPath, JSON.stringify(config), "utf8");

    agent.bot.memory.memoryModel = "missed-model";
    await fs.writeFile(agentConfigPath, JSON.stringify(agent), "utf8");
    await expect(assertProviderRouteLockDocuments({
      configPath: result.configPath,
      agentConfigPath,
      envPath: result.envPath,
      providerId: "selected-codex",
      model: "gpt-5.6-sol",
      providerApiKeyEnv: "CODEX_KEY",
      onebotAccessTokenEnv: "ONEBOT_ACCESS_TOKEN"
    })).rejects.toThrow(
      "USER_TEST_PROVIDER_ROUTE_LOCK_INVALID: agent.bot.memory.memoryModel"
    );
    agent.bot.memory.memoryModel = "gpt-5.6-sol";
    agent.providers = { defaultProviderId: "unexpected", items: [] };
    await fs.writeFile(agentConfigPath, JSON.stringify(agent), "utf8");
    await expect(assertProviderRouteLockDocuments({
      configPath: result.configPath,
      agentConfigPath,
      envPath: result.envPath,
      providerId: "selected-codex",
      model: "gpt-5.6-sol",
      providerApiKeyEnv: "CODEX_KEY",
      onebotAccessTokenEnv: "ONEBOT_ACCESS_TOKEN"
    })).rejects.toThrow("USER_TEST_PROVIDER_ROUTE_LOCK_INVALID: agent.providers");

    delete agent.providers;
    await fs.writeFile(agentConfigPath, JSON.stringify(agent), "utf8");
    config.providers.items.push({
      id: "unexpected",
      kind: "codex-responses",
      model: "gpt-5.6-sol"
    });
    await fs.writeFile(result.configPath, JSON.stringify(config), "utf8");
    await expect(assertProviderRouteLockDocuments({
      configPath: result.configPath,
      agentConfigPath,
      envPath: result.envPath,
      providerId: "selected-codex",
      model: "gpt-5.6-sol",
      providerApiKeyEnv: "CODEX_KEY",
      onebotAccessTokenEnv: "ONEBOT_ACCESS_TOKEN"
    })).rejects.toThrow("USER_TEST_PROVIDER_ROUTE_LOCK_INVALID: shared.providers");
  });

  it("rejects a missing or non-Codex locked provider before creating the destination", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-lock-provider-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    await writeRouteLockSource(source, "openai-compatible");

    const missingDestination = path.join(root, "missing-destination");
    await expect(prepareProviderSmokeWorkspace({
      source,
      destination: missingDestination,
      confirmCredentialCopy: true,
      providerId: "missing",
      model: "gpt-5.6-sol",
      lockProviderRoutes: true
    })).rejects.toThrow("USER_TEST_PROVIDER_ROUTE_LOCK_PROVIDER_NOT_FOUND: missing");
    await expect(fs.access(missingDestination)).rejects.toMatchObject({ code: "ENOENT" });

    const wrongKindDestination = path.join(root, "wrong-kind-destination");
    await expect(prepareProviderSmokeWorkspace({
      source,
      destination: wrongKindDestination,
      confirmCredentialCopy: true,
      providerId: "selected",
      model: "gpt-5.6-sol",
      lockProviderRoutes: true
    })).rejects.toThrow("USER_TEST_PROVIDER_ROUTE_LOCK_PROVIDER_KIND_INVALID");
    await expect(fs.access(wrongKindDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an empty locked model and lock parameters without the lock flag", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-lock-model-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    await writeRouteLockSource(source, "codex-responses");

    const emptyModelDestination = path.join(root, "empty-model-destination");
    await expect(prepareProviderSmokeWorkspace({
      source,
      destination: emptyModelDestination,
      confirmCredentialCopy: true,
      providerId: "selected",
      model: "   ",
      lockProviderRoutes: true
    })).rejects.toThrow("USER_TEST_PROVIDER_ROUTE_LOCK_MODEL_REQUIRED");
    await expect(fs.access(emptyModelDestination)).rejects.toMatchObject({ code: "ENOENT" });

    const unlockedDestination = path.join(root, "unlocked-destination");
    await expect(prepareProviderSmokeWorkspace({
      source,
      destination: unlockedDestination,
      confirmCredentialCopy: true,
      providerId: "selected",
      model: "gpt-5.6-sol"
    })).rejects.toThrow("USER_TEST_PROVIDER_ROUTE_LOCK_FLAG_REQUIRED");
    await expect(fs.access(unlockedDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes the destination when a post-copy prepare write fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-prepare-smoke-write-failure-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await writeRouteLockSource(source, "codex-responses");

    await expect(prepareProviderSmokeWorkspace({
      source,
      destination,
      confirmCredentialCopy: true,
      providerId: "selected",
      model: "gpt-5.6-sol",
      lockProviderRoutes: true,
      copyAgentWorkspace: async ({
        source: agentSource,
        destination: agentDestination
      }: {
        source: string;
        destination: string;
      }) => {
        await fs.cp(agentSource, agentDestination, { recursive: true });
        await fs.mkdir(
          path.join(agentDestination, "../../config/sunabot.json"),
          { recursive: true }
        );
      }
    })).rejects.toThrow();
    await expect(fs.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps external tool schemas while blocked harness executions stay local", async () => {
    const executor = new RegistryProviderToolExecutor();
    const generateImage = vi.fn();
    const runSelfie = vi.fn();
    const onToolCall = vi.fn();
    const codexDispatch = vi.fn();
    const blockedToolExecutions = [
      "websearch",
      "webfetch",
      "generate_img",
      "selfie",
      "send_voice_message",
      "codex"
    ] as const;
    const options = {
      bot: defaultConfig().bot,
      asyncCodex: true,
      codexControl: true,
      generateImage,
      selfie: {
        enabled: true,
        referenceImageUrls: [],
        run: runSelfie
      },
      voice: {
        enabled: true,
        languages: ["ja" as const],
        defaultLanguage: "ja" as const
      },
      blockedToolExecutions,
      onToolCall
    };
    const definitions = executor.resolveDefinitions(options);
    const definitionNames = definitions
      .map((definition) => String(definition.name ?? ""))
      .filter(Boolean);
    expect(definitionNames).toEqual(expect.arrayContaining(blockedToolExecutions));

    const calls = blockedToolExecutions.map((name, index) => ({
      type: "function_call" as const,
      name,
      call_id: `blocked-${index}`,
      arguments: "{}"
    }));
    expect(executor.companionTurn(
      [calls.at(-1)!],
      "fixture voice text",
      options,
      definitions
    )).toBeNull();
    const codexCall = calls.find((call) => call.name === "codex")!;
    const deferredCodex = executor.deferredTurn(
      [codexCall],
      options,
      definitions
    );
    if (deferredCodex) codexDispatch(deferredCodex);
    const outputs = await executor.execute(calls, options, definitions);
    expect(outputs).toHaveLength(blockedToolExecutions.length);
    for (const output of outputs) {
      expect(JSON.parse(String(output.output))).toMatchObject({
        ok: false,
        error: expect.stringContaining("unavailable in this run")
      });
    }
    expect(generateImage).not.toHaveBeenCalled();
    expect(runSelfie).not.toHaveBeenCalled();
    expect(onToolCall).not.toHaveBeenCalled();
    expect(codexDispatch).not.toHaveBeenCalled();
  });
});

async function write(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function writeRouteLockSource(source: string, kind: string) {
  await write(path.join(source, "config/sunabot.json"), JSON.stringify({
    persona: { defaultAgentId: "plana", agentWorkspace: "workspace/agents/plana" },
    providers: {
      defaultProviderId: "selected",
      items: [{
        id: "selected",
        kind,
        model: "source-model",
        apiKeyEnv: "SELECTED_KEY",
        envFile: "workspace/.env"
      }]
    },
    bot: routeBot("source-provider", "source-model")
  }));
  await write(path.join(source, ".env"), "SELECTED_KEY=selected-secret\n");
  await write(path.join(source, "agents/plana/agent.json"), JSON.stringify({
    schemaVersion: 1,
    id: "plana",
    bot: routeBot("agent-provider", "agent-model")
  }));
}

function routeBot(providerId: string, model: string) {
  return {
    replyProviderId: providerId,
    replyModel: model,
    imageReader: { providerId, model },
    tone: { providerId, model },
    memory: { memoryProviderId: providerId, memoryModel: model },
    orchestrator: {
      userGroupchatOrchestratorProviderId: providerId,
      userGroupchatOrchestratorModel: model,
      groupThreadProviderId: providerId,
      groupThreadModel: model
    },
    tools: { codex: { model } },
    bash: { auditModel: model }
  };
}

function codexAuthPath(workspace: string) {
  return path.join(workspace, WORKSPACE_LAYOUT.codexHome, "auth.json");
}

function expectRouteLock(
  document: Record<string, any>,
  providerId: string,
  model: string
) {
  expect(document.bot).toMatchObject({
    replyProviderId: providerId,
    replyModel: model,
    imageReader: { providerId, model },
    tone: { providerId, model },
    memory: { memoryProviderId: providerId, memoryModel: model },
    orchestrator: {
      userGroupchatOrchestratorProviderId: providerId,
      userGroupchatOrchestratorModel: model,
      groupThreadProviderId: providerId,
      groupThreadModel: model
    },
    tools: { codex: { model } },
    bash: { auditModel: model }
  });
}
