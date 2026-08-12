// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const configStore = vi.hoisted(() => ({
  config: null as AppConfig | null,
  configPath: "",
  rootDir: ""
}));

vi.mock("../../src/config.js", async () => {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  return {
    getConfigPath: () => configStore.configPath,
    getRootDir: () => configStore.rootDir,
    getWorkspaceDir: () => path.join(configStore.rootDir, "workspace"),
    getWorkspacePath: (...segments: string[]) => path.join(configStore.rootDir, "workspace", ...segments),
    resolveProjectPath: (inputPath: string | undefined) => {
      if (!inputPath) return undefined;
      return path.isAbsolute(inputPath) ? inputPath : path.join(configStore.rootDir, inputPath);
    },
    loadConfig: async () => structuredClone(configStore.config),
    saveConfig: async (nextConfig: AppConfig) => {
      configStore.config = structuredClone(nextConfig);
      await fs.writeFile(configStore.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
    }
  };
});

import { ConfigService, configRevision } from "../../src/admin/configService.js";
import { AdminMutationMutex } from "../../src/admin/mutation.js";

let rootDir = "";

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-config-service-"));
  configStore.rootDir = rootDir;
  configStore.configPath = path.join(rootDir, "sunabot.json");
  configStore.config = createAdminTestConfig(rootDir);
  configStore.config.persona.agentWorkspace = "workspace/business/agents/plana";
  delete process.env.SUNABOT_TEST_MISSING_API_KEY;
  await fs.writeFile(configStore.configPath, `${JSON.stringify(configStore.config, null, 2)}\n`, "utf8");
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  configStore.config = null;
  configStore.configPath = "";
  configStore.rootDir = "";
});

describe("ConfigService", () => {
  it("atomically patches the user-group gate and orchestrator settings", async () => {
    const commit = vi.fn();
    const service = new ConfigService({
      prepareApply: async () => ({ commit }),
      mutex: new AdminMutationMutex()
    });
    const before = currentConfig();

    const result = await service.patchGroupReply({
      revision: configRevision(before),
      value: {
        enabled: false,
        orchestrator: {
          ...before.bot.orchestrator,
          enabled: true,
          messageThreshold: 7
        }
      }
    });

    expect(result).toMatchObject({ ok: true, applyMode: "hot", restartRequiredFields: [] });
    expect(currentConfig().onebot.autoReplyUserGroup).toBe(false);
    expect(currentConfig().bot.orchestrator).toMatchObject({ enabled: true, messageThreshold: 7 });
    expect(commit).toHaveBeenCalledOnce();
  });

  it("patches one section, commits the prepared runtime and persists a new revision", async () => {
    const commit = vi.fn();
    const prepareApply = vi.fn(async () => ({ commit }));
    const service = new ConfigService({ prepareApply, mutex: new AdminMutationMutex() });
    const before = currentConfig();
    const revision = configRevision(before);

    const result = await service.patch("bot", {
      revision,
      value: {
        adminQq: "3971235731",
        adminName: "Updated Admin",
        replyModel: before.bot.replyModel,
        replyReasoningEffort: before.bot.replyReasoningEffort,
        imageReader: before.bot.imageReader,
        replyDebounceMs: 7_500,
        pokeOnNoReply: true,
        quoteGroupReplies: false,
        quoteGroupReplyExcludedUserIds: ["20001", "20002"],
        contextMessageLimit: 64,
        emojiSendSize: 128,
        emojiSendSeparately: true
      }
    });

    expect(prepareApply).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ok: true,
      applyMode: "hot",
      restartRequiredFields: []
    });
    expect(result.revision).not.toBe(revision);
    expect(currentConfig().bot).toMatchObject({
      adminQq: "3971235731",
      adminName: "Updated Admin",
      replyDebounceMs: 7_500,
      pokeOnNoReply: true,
      quoteGroupReplies: false,
      quoteGroupReplyExcludedUserIds: ["20001", "20002"],
      contextMessageLimit: 64,
      emojiSendSize: 128,
      emojiSendSeparately: true
    });
    expect(currentConfig().onebot.quoteGroupReplies).toBe(false);

    const persisted = JSON.parse(await fs.readFile(configStore.configPath, "utf8")) as AppConfig;
    expect(persisted).toEqual(currentConfig());
    await expect(fs.stat(`${configStore.configPath}.admin-backup`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an extra section field before preparing or persisting", async () => {
    const prepareApply = vi.fn(async () => ({ commit: vi.fn() }));
    const service = new ConfigService({ prepareApply, mutex: new AdminMutationMutex() });
    const before = currentConfig();

    await expect(service.patch("server", {
      revision: configRevision(before),
      value: {
        host: "127.0.0.1",
        port: 9_999,
        unexpected: true
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_UNKNOWN_FIELD",
      field: "server.unexpected"
    });

    expect(prepareApply).not.toHaveBeenCalled();
    expect(currentConfig()).toEqual(before);
  });

  it("rejects an unsupported emoji sending size before applying config", async () => {
    const prepareApply = vi.fn(async () => ({ commit: vi.fn() }));
    const service = new ConfigService({ prepareApply, mutex: new AdminMutationMutex() });
    const before = currentConfig();

    await expect(service.patch("bot", {
      revision: configRevision(before),
      value: { ...botSection(before.bot.adminName), emojiSendSize: 96 }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "bot.emojiSendSize"
    });
    expect(prepareApply).not.toHaveBeenCalled();
  });

  it("rejects arbitrary and absolute Plana workspace paths before preparing or persisting", async () => {
    const prepareApply = vi.fn(async () => ({ commit: vi.fn() }));
    const service = new ConfigService({ prepareApply, mutex: new AdminMutationMutex() });
    const before = currentConfig();

    for (const agentWorkspace of ["workspace/agents/plana", path.join(rootDir, "agent-workspace")]) {
      await expect(service.patch("persona", {
        revision: configRevision(before),
        value: { agentWorkspace }
      })).rejects.toMatchObject({
        statusCode: 400,
        code: "CONFIG_INVALID",
        field: "persona.agentWorkspace"
      });
    }

    expect(prepareApply).not.toHaveBeenCalled();
    expect(currentConfig()).toEqual(before);
  });

  it("rejects a stale revision and reports the latest revision", async () => {
    const prepareApply = vi.fn(async () => ({ commit: vi.fn() }));
    const service = new ConfigService({ prepareApply, mutex: new AdminMutationMutex() });
    const latestRevision = configRevision(currentConfig());

    await expect(service.patch("server", {
      revision: "stale-revision",
      value: {
        host: "127.0.0.1",
        port: 9_999
      }
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFIG_REVISION_CONFLICT",
      latestRevision
    });

    expect(prepareApply).not.toHaveBeenCalled();
  });

  it("serializes concurrent patches so only one request with the same revision succeeds", async () => {
    let releaseFirst!: () => void;
    let markFirstPrepared!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstPrepared = new Promise<void>((resolve) => {
      markFirstPrepared = resolve;
    });
    const prepareApply = vi.fn(async () => {
      if (prepareApply.mock.calls.length === 1) {
        markFirstPrepared();
        await firstGate;
      }
      return { commit: vi.fn() };
    });
    const service = new ConfigService({ prepareApply, mutex: new AdminMutationMutex() });
    const revision = configRevision(currentConfig());

    const first = service.patch("bot", {
      revision,
      value: botSection("First Writer")
    });
    await firstPrepared;
    const second = service.patch("bot", {
      revision,
      value: botSection("Second Writer")
    });
    releaseFirst();

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        statusCode: 409,
        code: "CONFIG_REVISION_CONFLICT"
      })
    });
    expect(prepareApply).toHaveBeenCalledOnce();
    expect(currentConfig().bot.adminName).toBe("First Writer");
  });

  it("keeps provider, memory and orchestrator reasoning efforts independent", async () => {
    const service = new ConfigService({
      prepareApply: async () => ({ commit: vi.fn() }),
      mutex: new AdminMutationMutex()
    });
    const initial = currentConfig();

    const memoryResult = await service.patch("memory", {
      revision: configRevision(initial),
      value: {
        ...initial.bot.memory,
        reasoningEffort: "low"
      }
    });
    const afterMemory = currentConfig();
    await service.patch("orchestrator", {
      revision: memoryResult.revision,
      value: {
        ...afterMemory.bot.orchestrator,
        reasoningEffort: "high"
      }
    });

    const saved = currentConfig();
    expect(saved.providers.items[0]?.reasoningEffort).toBe("medium");
    expect(saved.bot.memory.reasoningEffort).toBe("low");
    expect(saved.bot.orchestrator.reasoningEffort).toBe("high");
  });

  it("persists sparse tool overrides as a hot configuration update", async () => {
    const service = new ConfigService({
      prepareApply: async () => ({ commit: vi.fn() }),
      mutex: new AdminMutationMutex()
    });
    const initial = currentConfig();
    const tools = structuredClone(initial.bot.tools);
    tools.overrides = {
      websearch: { enabled: false, description: "  Search the live web only when needed.  " },
      codex: { description: "Delegate long-running work." }
    };

    const result = await service.patch("tools", {
      revision: configRevision(initial),
      value: tools
    });

    expect(result).toMatchObject({ ok: true, applyMode: "hot", restartRequiredFields: [] });
    expect(currentConfig().bot.tools.overrides).toEqual({
      websearch: { enabled: false, description: "Search the live web only when needed." },
      codex: { description: "Delegate long-running work." }
    });
  });

  it("rejects unknown tools and invalid override descriptions", async () => {
    const prepareApply = vi.fn(async () => ({ commit: vi.fn() }));
    const service = new ConfigService({ prepareApply, mutex: new AdminMutationMutex() });
    const initial = currentConfig();
    const revision = configRevision(initial);

    await expect(service.patch("tools", {
      revision,
      value: {
        ...initial.bot.tools,
        overrides: { unknown_tool: { enabled: false } }
      }
    })).rejects.toMatchObject({
      code: "CONFIG_UNKNOWN_FIELD",
      field: "tools.overrides.unknown_tool"
    });

    for (const description of ["invalid\0description", "x".repeat(4_001)]) {
      await expect(service.patch("tools", {
        revision,
        value: {
          ...initial.bot.tools,
          overrides: { websearch: { description } }
        }
      })).rejects.toMatchObject({
        code: "CONFIG_INVALID",
        field: "tools.overrides.websearch.description"
      });
    }
    expect(prepareApply).not.toHaveBeenCalled();
    expect(currentConfig()).toEqual(initial);
  });

  it("keeps an existing provider type immutable", async () => {
    const service = new ConfigService({
      prepareApply: async () => ({ commit: vi.fn() }),
      mutex: new AdminMutationMutex()
    });
    const initial = currentConfig();
    const providers = structuredClone(initial.providers);
    providers.items[0]!.kind = "anthropic-official";
    providers.items[0]!.baseUrl = "https://api.anthropic.com/v1";

    await expect(service.patch("providers", {
      revision: configRevision(initial),
      value: providers
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "providers.items.test-provider.kind"
    });
  });

  it("keeps official provider addresses fixed", async () => {
    const service = new ConfigService({
      prepareApply: async () => ({ commit: vi.fn() }),
      mutex: new AdminMutationMutex()
    });
    const initial = currentConfig();
    const providers = structuredClone(initial.providers);
    providers.items[0]!.baseUrl = "https://proxy.example.com/v1";

    await expect(service.patch("providers", {
      revision: configRevision(initial),
      value: providers
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "providers.items.0.baseUrl"
    });
  });
});

function currentConfig() {
  if (!configStore.config) throw new Error("Test config is not initialized.");
  return structuredClone(configStore.config);
}

function botSection(adminName: string) {
  const bot = currentConfig().bot;
  return {
    adminQq: bot.adminQq,
    adminName,
    replyModel: bot.replyModel,
    replyReasoningEffort: bot.replyReasoningEffort,
    imageReader: bot.imageReader,
    replyDebounceMs: bot.replyDebounceMs,
    pokeOnNoReply: bot.pokeOnNoReply,
    quoteGroupReplies: bot.quoteGroupReplies,
    quoteGroupReplyExcludedUserIds: bot.quoteGroupReplyExcludedUserIds,
    contextMessageLimit: bot.contextMessageLimit,
    emojiSendSize: bot.emojiSendSize,
    emojiSendSeparately: bot.emojiSendSeparately
  };
}
