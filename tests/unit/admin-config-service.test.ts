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

import { ConfigService, configFieldStates } from "../../src/admin/configService.js";
import { MODEL_CATALOG } from "../../src/admin/models.js";
import { AdminMutationMutex } from "../../src/admin/mutation.js";

let rootDir = "";
let activeConfig: AppConfig;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-admin-config-"));
  configStore.rootDir = rootDir;
  configStore.configPath = path.join(rootDir, "sunabot.json");
  configStore.config = createAdminTestConfig(rootDir);
  configStore.config.persona.agentWorkspace = "workspace/business/agents/plana";
  activeConfig = structuredClone(configStore.config);
  delete process.env.SUNABOT_TEST_MISSING_API_KEY;
  await fs.writeFile(configStore.configPath, `${JSON.stringify(configStore.config, null, 2)}\n`, "utf8");
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  configStore.config = null;
  configStore.configPath = "";
  configStore.rootDir = "";
});

describe("ConfigService section semantics", () => {
  it("reports apply state for every persisted config leaf", () => {
    const config = structuredClone(configStore.config!);
    const states = configFieldStates(config);
    for (const field of leafPaths(config)) {
      expect(states[field], field).toBeDefined();
    }
    expect(states["server.port"]?.applyMode).toBe("restart");
    expect(states["onebot.accessTokenEnv"]?.applyMode).toBe("reconnect");
  });

  it("persists the Agent reply debounce time as a hot setting", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();
    const result = await subject.patch("bot", {
      revision: envelope.revision,
      value: {
        adminQq: envelope.config.bot.adminQq,
        adminName: envelope.config.bot.adminName,
        replyDebounceMs: 7_500,
        pokeOnNoReply: envelope.config.bot.pokeOnNoReply,
        quoteGroupReplies: envelope.config.bot.quoteGroupReplies,
        quoteGroupReplyExcludedUserIds: envelope.config.bot.quoteGroupReplyExcludedUserIds,
        emojiSendSize: envelope.config.bot.emojiSendSize,
        contextMessageLimit: envelope.config.bot.contextMessageLimit
      }
    });

    expect(result.config.bot.replyDebounceMs).toBe(7_500);
    expect(result.applyMode).toBe("hot");
    expect(result.fieldStates["bot.replyDebounceMs"]?.applyMode).toBe("hot");
  });

  it.each([999, 60_001])("rejects an out-of-range Agent reply debounce time: %s", async (replyDebounceMs) => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("bot", {
      revision: envelope.revision,
      value: {
        adminQq: envelope.config.bot.adminQq,
        adminName: envelope.config.bot.adminName,
        replyDebounceMs,
        pokeOnNoReply: envelope.config.bot.pokeOnNoReply,
        quoteGroupReplies: envelope.config.bot.quoteGroupReplies,
        quoteGroupReplyExcludedUserIds: envelope.config.bot.quoteGroupReplyExcludedUserIds,
        emojiSendSize: envelope.config.bot.emojiSendSize,
        contextMessageLimit: envelope.config.bot.contextMessageLimit
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "bot.replyDebounceMs"
    });
  });

  it("persists independent tone settings as a hot Agent section", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();
    const providerId = envelope.config.providers.items.find((provider) => provider.enabled)!.id;
    const result = await subject.patch("tone", {
      revision: envelope.revision,
      value: {
        enabled: true,
        followMainModel: false,
        providerId,
        model: "gpt-5.5",
        reasoningEffort: "high",
        temperature: 1.1,
        maxOutputTokens: 3200,
        maxRetries: 4
      }
    });

    expect(result.config.bot.tone).toEqual({
      enabled: true,
      followMainModel: false,
      providerId,
      model: "gpt-5.5",
      reasoningEffort: "high",
      temperature: 1.1,
      maxOutputTokens: 3200,
      maxRetries: 4
    });
    expect(result.applyMode).toBe("hot");
    expect(result.fieldStates["bot.tone.enabled"]?.applyMode).toBe("hot");
  });

  it.each([
    ["providerId", "missing-provider", "tone.providerId"],
    ["temperature", 2.1, "tone.temperature"],
    ["maxOutputTokens", 0, "tone.maxOutputTokens"],
    ["maxRetries", 11, "tone.maxRetries"]
  ] as const)("rejects invalid tone %s", async (key, value, field) => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("tone", {
      revision: envelope.revision,
      value: { ...envelope.config.bot.tone, [key]: value }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field
    });
  });

  it("reports server changes as restart-only without replacing other sections", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();
    const result = await subject.patch("server", {
      revision: envelope.revision,
      value: { host: "127.0.0.1", port: 9_988 }
    });

    expect(result.config.server.port).toBe(9_988);
    expect(result.config.bot).toEqual(envelope.config.bot);
    expect(activeConfig.server.port).toBe(9_988);
    expect(result.applyMode).toBe("restart");
    expect(result.restartRequiredFields).toEqual(["server.port"]);
    const persisted = JSON.parse(await fs.readFile(configStore.configPath, "utf8")) as AppConfig;
    expect(persisted.server.port).toBe(9_988);
  });

  it("rejects a catalog model effort that the selected model does not support", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("memory", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.memory,
        memoryModel: "gpt-5.4-mini",
        reasoningEffort: "ultra"
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "memory.reasoningEffort"
    });
  });

  it("persists an independent group thread model while the orchestrator is disabled", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    const result = await subject.patch("orchestrator", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.orchestrator,
        enabled: false,
        groupThreadModel: "  custom-low-cost-model  "
      }
    });

    expect(result.config.bot.orchestrator).toMatchObject({
      enabled: false,
      userGroupchatOrchestratorModel: "gpt-5.4-mini",
      groupThreadModel: "custom-low-cost-model"
    });
    expect(result.applyMode).toBe("hot");
  });

  it("rejects an empty group thread model", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("orchestrator", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.orchestrator,
        groupThreadModel: "   "
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "orchestrator.groupThreadModel"
    });
  });

  it("accepts every catalog model for Codex", async () => {
    const subject = service();

    for (const model of MODEL_CATALOG) {
      const envelope = await subject.readEnvelope();
      const result = await subject.patch("tools", {
        revision: envelope.revision,
        value: {
          ...envelope.config.bot.tools,
          codex: {
            ...envelope.config.bot.tools.codex,
            model: model.id
          }
        }
      });

      expect(result.config.bot.tools.codex.model).toBe(model.id);
      expect(result.applyMode).toBe("hot");
    }
  });

  it("persists a valid image quality setting", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();
    const result = await subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        generateImg: {
          ...envelope.config.bot.tools.generateImg,
          quality: "auto"
        }
      }
    });

    expect(result.config.bot.tools.generateImg.quality).toBe("auto");
    expect(configStore.config!.bot.tools.generateImg.quality).toBe("auto");
  });

  it("rejects an unsupported image quality setting", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        generateImg: {
          ...envelope.config.bot.tools.generateImg,
          quality: "maximum"
        }
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "tools.generateImg.quality"
    });
  });

  it("redacts Tavily keys and preserves them during unrelated tools saves", async () => {
    configStore.config!.bot.tools.websearch.tavilyApiKey = "tvly-stored-secret-1234567890";
    const subject = service();
    const envelope = await subject.readEnvelope();

    expect(envelope.config.bot.tools.websearch.tavilyApiKey).toBe("");
    expect(envelope.config.bot.tools.websearch.tavilyApiKeys).toEqual([]);
    expect(envelope.fieldStates["bot.tools.websearch.tavilyApiKey"]?.secretConfigured).toBe(true);
    expect(envelope.fieldStates["bot.tools.websearch.tavilyApiKeys"]?.storedSecretCount).toBe(1);

    const result = await subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        websearch: {
          ...envelope.config.bot.tools.websearch,
          maxResults: 7
        }
      }
    });

    expect(configStore.config!.bot.tools.websearch.tavilyApiKey).toBe("");
    expect(configStore.config!.bot.tools.websearch.tavilyApiKeys).toEqual(["tvly-stored-secret-1234567890"]);
    expect(result.config.bot.tools.websearch.tavilyApiKey).toBe("");
    expect(result.config.bot.tools.websearch.tavilyApiKeys).toEqual([]);
  });

  it("rejects the legacy Codex websearch provider", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        websearch: {
          ...envelope.config.bot.tools.websearch,
          provider: "codex-bash"
        }
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "tools.websearch.provider"
    });
  });

  it("adds, removes and migrates write-only Tavily key pools", async () => {
    configStore.config!.bot.tools.websearch.tavilyApiKeys = [
      "tvly-old-secret-1-1234567890",
      "tvly-old-secret-2-1234567890"
    ];
    const subject = service();
    let envelope = await subject.readEnvelope();

    await subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        websearch: {
          ...envelope.config.bot.tools.websearch,
          tavilyApiKeys: ["tvly-new-secret-1234567890"],
          removeTavilyApiKeyIndexes: [0]
        }
      }
    });
    expect(configStore.config!.bot.tools.websearch.tavilyApiKeys).toEqual([
      "tvly-old-secret-2-1234567890",
      "tvly-new-secret-1234567890"
    ]);

    envelope = await subject.readEnvelope();
    await subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        websearch: {
          ...envelope.config.bot.tools.websearch,
          removeTavilyApiKeyIndexes: [0, 1]
        }
      }
    });
    expect(configStore.config!.bot.tools.websearch.tavilyApiKeys).toEqual([]);

    envelope = await subject.readEnvelope();
    await subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        websearch: {
          ...envelope.config.bot.tools.websearch,
          tavilyApiKeyEnv: "tvly-migrated-secret-1234567890"
        }
      }
    });
    expect(configStore.config!.bot.tools.websearch).toMatchObject({
      tavilyApiKey: "",
      tavilyApiKeys: ["tvly-migrated-secret-1234567890"],
      tavilyApiKeyEnv: "TAVILY_API_KEY"
    });
  });

  it("rejects a Codex model outside the catalog", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        codex: {
          ...envelope.config.bot.tools.codex,
          model: "unknown-model"
        }
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "tools.codex.model"
    });
  });

  it("rejects invalid Codex worker limits", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        codex: { ...envelope.config.bot.tools.codex, timeoutMs: 999 }
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "tools.codex.timeoutMs"
    });

    await expect(subject.patch("tools", {
      revision: envelope.revision,
      value: {
        ...envelope.config.bot.tools,
        codex: { ...envelope.config.bot.tools.codex, maxConcurrency: 0 }
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "tools.codex.maxConcurrency"
    });
  });

  it("mirrors the authoritative bot quote setting into OneBot", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();
    const result = await subject.patch("bot", {
      revision: envelope.revision,
      value: {
        adminQq: envelope.config.bot.adminQq,
        adminName: envelope.config.bot.adminName,
        replyDebounceMs: envelope.config.bot.replyDebounceMs,
        pokeOnNoReply: envelope.config.bot.pokeOnNoReply,
        quoteGroupReplies: !envelope.config.bot.quoteGroupReplies,
        quoteGroupReplyExcludedUserIds: ["20001", "20001", "20002"],
        emojiSendSize: envelope.config.bot.emojiSendSize,
        contextMessageLimit: envelope.config.bot.contextMessageLimit
      }
    });

    expect(result.config.onebot.quoteGroupReplies).toBe(result.config.bot.quoteGroupReplies);
    expect(result.config.bot.quoteGroupReplyExcludedUserIds).toEqual(["20001", "20002"]);
  });

  it("rejects non-numeric QQ values in the quote filter", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("bot", {
      revision: envelope.revision,
      value: {
        adminQq: envelope.config.bot.adminQq,
        adminName: envelope.config.bot.adminName,
        replyDebounceMs: envelope.config.bot.replyDebounceMs,
        pokeOnNoReply: envelope.config.bot.pokeOnNoReply,
        quoteGroupReplies: envelope.config.bot.quoteGroupReplies,
        quoteGroupReplyExcludedUserIds: ["20001", "another-bot"],
        emojiSendSize: envelope.config.bot.emojiSendSize,
        contextMessageLimit: envelope.config.bot.contextMessageLimit
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "bot.quoteGroupReplyExcludedUserIds.1"
    });
  });

  it("hot-applies the system broadcast storm settings", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    const result = await subject.patch("broadcastStorm", {
      revision: envelope.revision,
      value: {
        enabled: false,
        windowMinutes: 5,
        replyThreshold: 6,
        cooldownMinutes: 7,
        additionalQqIds: ["10001", "10001", "20002"]
      }
    });

    expect(result.applyMode).toBe("hot");
    expect(result.config.broadcastStorm).toEqual({
      enabled: false,
      windowMinutes: 5,
      replyThreshold: 6,
      cooldownMinutes: 7,
      additionalQqIds: ["10001", "20002"]
    });
  });

  it("hot-applies the system normal reply retry limit", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    const result = await subject.patch("normalReply", {
      revision: envelope.revision,
      value: { maxRetries: 6 }
    });

    expect(result.applyMode).toBe("hot");
    expect(result.config.normalReply).toEqual({ maxRetries: 6 });
  });

  it.each([-1, 11, 1.5])("rejects invalid normal reply retry limits: %s", async (maxRetries) => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("normalReply", {
      revision: envelope.revision,
      value: { maxRetries }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "normalReply.maxRetries"
    });
  });

  it("rejects invalid broadcast storm parameters", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("broadcastStorm", {
      revision: envelope.revision,
      value: {
        enabled: true,
        windowMinutes: 0,
        replyThreshold: 3,
        cooldownMinutes: 1,
        additionalQqIds: []
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "broadcastStorm.windowMinutes"
    });
  });

  it("rejects non-numeric supplemental broadcast storm accounts", async () => {
    const subject = service();
    const envelope = await subject.readEnvelope();

    await expect(subject.patch("broadcastStorm", {
      revision: envelope.revision,
      value: {
        enabled: true,
        windowMinutes: 2,
        replyThreshold: 3,
        cooldownMinutes: 1,
        additionalQqIds: ["10001", "another-bot"]
      }
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "CONFIG_INVALID",
      field: "broadcastStorm.additionalQqIds.1"
    });
  });

  it("verifies a prepared apply before writing config and leaves disk unchanged when verification fails", async () => {
    const verify = vi.fn(async () => {
      throw new Error("prepared state changed");
    });
    const commit = vi.fn();
    const prepareApply = vi.fn(async () => ({ verify, commit }));
    const subject = new ConfigService({
      mutex: new AdminMutationMutex(),
      prepareApply
    });
    const envelope = await subject.readEnvelope();
    const beforeDisk = await fs.readFile(configStore.configPath, "utf8");
    const beforeConfig = structuredClone(configStore.config);

    await expect(subject.patch("server", {
      revision: envelope.revision,
      value: { ...envelope.config.server, port: envelope.config.server.port + 1 }
    })).rejects.toThrow("prepared state changed");

    expect(prepareApply).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(configStore.config).toEqual(beforeConfig);
    expect(await fs.readFile(configStore.configPath, "utf8")).toBe(beforeDisk);
    await expect(fs.stat(`${configStore.configPath}.admin-backup`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function leafPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leafPaths(item, `${prefix}.${index}`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => leafPaths(child, prefix ? `${prefix}.${key}` : key));
  }
  return [prefix];
}

function service() {
  return new ConfigService({
    mutex: new AdminMutationMutex(),
    prepareApply: vi.fn(async (candidate: AppConfig) => ({
      commit() {
        activeConfig = structuredClone(candidate);
      }
    }))
  });
}
