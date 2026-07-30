// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "../../src/config.js";

let rootDir = "";
let configPath = "";
let originalConfigPath: string | undefined;
let originalHost: string | undefined;
let originalPort: string | undefined;
let originalRuntimeMode: string | undefined;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-config-load-"));
  configPath = path.join(rootDir, "sunabot.json");
  originalConfigPath = process.env.SUNABOT_CONFIG;
  originalHost = process.env.SUNABOT_HOST;
  originalPort = process.env.SUNABOT_PORT;
  originalRuntimeMode = process.env.SUNABOT_RUNTIME_MODE;
  process.env.SUNABOT_CONFIG = configPath;
  delete process.env.SUNABOT_HOST;
  delete process.env.SUNABOT_PORT;
  delete process.env.SUNABOT_RUNTIME_MODE;
});

afterEach(async () => {
  if (originalConfigPath == null) delete process.env.SUNABOT_CONFIG;
  else process.env.SUNABOT_CONFIG = originalConfigPath;
  if (originalHost == null) delete process.env.SUNABOT_HOST;
  else process.env.SUNABOT_HOST = originalHost;
  if (originalPort == null) delete process.env.SUNABOT_PORT;
  else process.env.SUNABOT_PORT = originalPort;
  if (originalRuntimeMode == null) delete process.env.SUNABOT_RUNTIME_MODE;
  else process.env.SUNABOT_RUNTIME_MODE = originalRuntimeMode;
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe("tool configuration", () => {
  it("lets the runtime contract override a migrated file server address", async () => {
    process.env.SUNABOT_HOST = "0.0.0.0";
    process.env.SUNABOT_PORT = "8787";
    await fs.writeFile(configPath, JSON.stringify({
      server: { host: "127.0.0.1", port: 18_876 }
    }), "utf8");

    await expect(loadConfig()).resolves.toMatchObject({
      server: { host: "0.0.0.0", port: 8_787 }
    });
  });

  it("uses the versioned workspace layout for agents and provider secrets", () => {
    const config = defaultConfig();
    expect(config.schemaVersion).toBe(1);
    expect(config.persona.agentWorkspace).toBe("workspace/business/agents/plana");
    expect(config.providers.items.every((provider) => provider.envFile === "workspace/secrets/runtime.env")).toBe(true);
    expect(config.bot.adminQq).toBe("");
    expect(config.bot.replyDebounceMs).toBe(5_000);
    expect(config.bot.contextMessageLimit).toBe(32);
    expect(config.bot.emojiSendSize).toBe(512);
    expect(config.bot.emojiSendSeparately).toBe(false);
    expect(config.bot.tone).toEqual({
      enabled: false,
      segmentedReply: false,
      followMainModel: false,
      providerId: "",
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      temperature: 0.7,
      maxOutputTokens: 2400,
      maxRetries: 2
    });
    expect(config.bot.memory).toMatchObject({
      dreamRecentWindowHours: 24,
      dreamRecentMemoryLimit: 24,
      dreamOlderMemoryLimit: 12
    });
  });

  it("loads Dream sampling settings and safely defaults invalid legacy combinations", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        memory: {
          dreamRecentWindowHours: 36,
          dreamRecentMemoryLimit: 8,
          dreamOlderMemoryLimit: 10
        }
      }
    }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: {
        memory: {
          dreamRecentWindowHours: 36,
          dreamRecentMemoryLimit: 8,
          dreamOlderMemoryLimit: 10
        }
      }
    });

    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        memory: {
          dreamRecentWindowHours: 900,
          dreamRecentMemoryLimit: 30,
          dreamOlderMemoryLimit: 30
        }
      }
    }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: {
        memory: {
          dreamRecentWindowHours: 24,
          dreamRecentMemoryLimit: 24,
          dreamOlderMemoryLimit: 12
        }
      }
    });
  });

  it("loads an allowed emoji sending size and defaults invalid legacy values", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: { emojiSendSize: 128, emojiSendSeparately: true }
    }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: { emojiSendSize: 128, emojiSendSeparately: true }
    });

    await fs.writeFile(configPath, JSON.stringify({ bot: { emojiSendSize: 96 } }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: { emojiSendSize: 512, emojiSendSeparately: false }
    });
  });

  it("loads a configured Agent reply debounce time and defaults missing legacy values", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: { replyDebounceMs: 7_500 }
    }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: { replyDebounceMs: 7_500 }
    });

    await fs.writeFile(configPath, JSON.stringify({ bot: {} }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: { replyDebounceMs: 5_000 }
    });
  });

  it("defaults conversation context to 32 messages while preserving an explicit legacy value", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: { contextMessageLimit: 48 }
    }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: { contextMessageLimit: 48 }
    });

    await fs.writeFile(configPath, JSON.stringify({ bot: {} }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: { contextMessageLimit: 32 }
    });
  });

  it("loads independent tone settings and defaults a missing legacy section", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        tone: {
          enabled: true,
          segmentedReply: true,
          followMainModel: true,
          providerId: "openai",
          model: "gpt-5.5",
          reasoningEffort: "high",
          temperature: 1.1,
          maxOutputTokens: 3200,
          maxRetries: 4
        }
      }
    }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: {
        tone: {
          enabled: true,
          segmentedReply: true,
          followMainModel: true,
          providerId: "openai",
          model: "gpt-5.5",
          reasoningEffort: "high",
          temperature: 1.1,
          maxOutputTokens: 3200,
          maxRetries: 4
        }
      }
    });

    await fs.writeFile(configPath, JSON.stringify({ bot: {} }), "utf8");
    await expect(loadConfig()).resolves.toMatchObject({
      bot: {
        tone: {
          enabled: false,
          segmentedReply: false,
          followMainModel: false,
          providerId: "",
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
          temperature: 0.7,
          maxOutputTokens: 2400,
          maxRetries: 2
        }
      }
    });
  });

  it("rejects a configuration written by a newer schema", async () => {
    await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 2 }), "utf8");

    await expect(loadConfig()).rejects.toMatchObject({ code: "CONFIG_SCHEMA_VERSION_UNSUPPORTED" });
  });

  it("normalizes retired custom Plana workspace paths to the canonical workspace", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      persona: {
        agentWorkspace: path.join(rootDir, "custom-agent-workspace")
      }
    }), "utf8");

    await expect(loadConfig()).resolves.toMatchObject({
      persona: { agentWorkspace: "workspace/business/agents/plana" }
    });
  });

  it("drops the retired persona memory limit while loading old config", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      persona: {
        agentWorkspace: "workspace/business/agents/plana",
        memoryLimit: 12
      }
    }), "utf8");

    const config = await loadConfig();

    expect(Object.hasOwn(config.persona, "memoryLimit")).toBe(false);
  });

  it("maps legacy provider kinds to the current protocol types", async () => {
    const template = defaultConfig().providers.items[1]!;
    await fs.writeFile(configPath, JSON.stringify({
      providers: {
        defaultProviderId: "legacy-openai",
        items: [
          { ...template, id: "legacy-openai", kind: "openai-responses" },
          { ...template, id: "legacy-gemini", kind: "gemini-openai" },
          { ...template, id: "legacy-anthropic", kind: "anthropic-openai" }
        ]
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.providers.items.map((provider) => provider.kind)).toEqual([
      "openai-official",
      "openai-compatible",
      "anthropic-official"
    ]);
  });

  it("restores the model source default for legacy providers", async () => {
    const template = defaultConfig().providers.items[1]!;
    const official = { ...template, id: "legacy-official", kind: "anthropic-official" as const };
    const compatible = { ...template, id: "legacy-compatible", kind: "openai-compatible" as const };
    delete official.modelSource;
    delete compatible.modelSource;
    await fs.writeFile(configPath, JSON.stringify({
      providers: {
        defaultProviderId: official.id,
        items: [official, compatible]
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.providers.items.map((provider) => provider.modelSource)).toEqual(["remote", "custom"]);
  });

  it("defaults workspace Bash to disabled with a Docker strict backend", () => {
    expect(defaultConfig().bot.bash).toMatchObject({
      enabled: false,
      adminPrivateBackend: "docker",
      auditModel: "gpt-5.4-mini",
      strictMode: true
    });
    process.env.SUNABOT_RUNTIME_MODE = "macos";
    expect(defaultConfig().bot.bash.enabled).toBe(false);
  });

  it("loads the administrator private Bash backend from sparse legacy-compatible config", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        bash: {
          enabled: true,
          adminPrivateBackend: "docker",
          auditModel: "gpt-5.5",
          strictMode: false
        }
      }
    }), "utf8");

    await expect(loadConfig()).resolves.toMatchObject({
      bot: {
        bash: {
          enabled: true,
          adminPrivateBackend: "docker",
          auditModel: "gpt-5.5",
          strictMode: false,
          allowGroup: false,
          adminOnly: true,
          workspaceOnly: true
        }
      }
    });
  });

  it("defaults websearch to Tavily and Codex to an independent worker", () => {
    expect(defaultConfig().bot.pokeOnNoReply).toBe(false);
    expect(defaultConfig().normalReply).toEqual({ maxRetries: 3 });
    expect(defaultConfig().broadcastStorm).toEqual({
      enabled: true,
      windowMinutes: 2,
      replyThreshold: 3,
      cooldownMinutes: 1,
      additionalQqIds: []
    });
    expect(defaultConfig().bot.tools.maxCalls).toBe(20);
    expect(defaultConfig().bot.tools.overrides).toEqual({});
    expect(defaultConfig().bot.tools.websearch).toMatchObject({
      provider: "tavily",
      tavilyApiKey: "",
      tavilyApiKeys: [],
      tavilyApiKeyEnv: "TAVILY_API_KEY"
    });
    expect(defaultConfig().bot.tools.codex).toEqual({
      enabled: true,
      model: "gpt-5.4-mini",
      codexExecutable: "auto",
      timeoutMs: 900_000,
      maxConcurrency: 2
    });
  });

  it("loads a persisted normal reply retry limit", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      normalReply: { maxRetries: 7 }
    }), "utf8");

    await expect(loadConfig()).resolves.toMatchObject({
      normalReply: { maxRetries: 7 }
    });
  });

  it("migrates legacy Codex websearch settings into the Codex worker", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        tools: {
          websearch: {
            provider: "codex-bash",
            model: "gpt-5.5",
            codexExecutable: "/custom/codex",
            tavilyApiKeyEnv: "TAVILY_API_KEY",
            maxResults: 5
          }
        }
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.bot.tools.websearch).toMatchObject({
      provider: "tavily",
      tavilyApiKey: ""
    });
    expect(config.bot.tools.codex).toMatchObject({
      enabled: true,
      model: "gpt-5.5",
      codexExecutable: "/custom/codex",
      timeoutMs: 900_000,
      maxConcurrency: 2
    });
  });

  it("prefers explicit Codex settings over legacy websearch fields", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        tools: {
          websearch: {
            provider: "codex-bash",
            model: "gpt-5.5",
            codexExecutable: "/legacy/codex",
            maxResults: 5
          },
          codex: {
            enabled: false,
            model: "gpt-5.4-mini",
            codexExecutable: "/new/codex",
            timeoutMs: 30_000,
            maxConcurrency: 4
          }
        }
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.bot.tools.codex).toEqual({
      enabled: false,
      model: "gpt-5.4-mini",
      codexExecutable: "/new/codex",
      timeoutMs: 30_000,
      maxConcurrency: 4
    });
  });

  it("fills sparse tool overrides without changing legacy tool capability settings", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        tools: {
          overrides: {
            websearch: { enabled: false, description: "  Search only when explicitly enabled.  " },
            codex: { enabled: false, description: "  Delegate long work.  " },
            workspace_bash: { enabled: true, description: "  Run workspace commands.  " },
            unknown_tool: { enabled: false }
          },
          codex: { enabled: false }
        }
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.bot.tools.overrides).toEqual({
      websearch: { enabled: false, description: "Search only when explicitly enabled." },
      codex: { description: "Delegate long work." },
      docker_bash: { description: "Run workspace commands." }
    });
    expect(config.bot.tools.codex.enabled).toBe(false);
  });

  it("migrates the reply model and image reader from legacy Provider settings", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      providers: {
        defaultProviderId: "text",
        items: [{
          ...defaultConfig().providers.items[0],
          id: "text",
          model: "reply-model",
          visionProviderId: "vision",
          visionModel: "vision-model"
        }, {
          ...defaultConfig().providers.items[1],
          id: "vision",
          model: "vision-fallback"
        }]
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.bot.replyModel).toBe("reply-model");
    expect(config.bot.imageReader).toMatchObject({
      enabled: true,
      providerId: "vision",
      model: "vision-model"
    });
  });

  it("migrates a direct key from the legacy Tavily env field", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        tools: {
          websearch: {
            provider: "tavily",
            tavilyApiKeyEnv: "tvly-test-1234567890",
            maxResults: 5
          }
        }
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.bot.tools.websearch).toMatchObject({
      tavilyApiKey: "",
      tavilyApiKeys: ["tvly-test-1234567890"],
      tavilyApiKeyEnv: "TAVILY_API_KEY"
    });
  });
});

describe("image quality configuration", () => {
  it("defaults new configurations to high quality", () => {
    expect(defaultConfig().bot.tools.generateImg.quality).toBe("high");
  });

  it("fills the configured default when loading a legacy configuration", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        tools: {
          generateImg: {
            provider: "codex-image-gen",
            size: "1024x1024",
            resolution: "1K"
          }
        }
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.bot.tools.generateImg.quality).toBe("high");
  });
});

describe("prompt template configuration", () => {
  it("fills the remaining orchestrator defaults when loading a partial config", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        orchestrator: {
          enabled: true,
          userGroupchatOrchestratorModel: "gpt-5.6-luna"
        }
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.bot.orchestrator.userGroupchatOrchestratorModel).toBe("gpt-5.6-luna");
    expect(config.bot.orchestrator.promptFile).toBe("user_groupchat_orchestrator.json");
  });

  it("migrates the legacy default MD request names to final JSON templates", async () => {
    await fs.writeFile(configPath, JSON.stringify({
      bot: {
        memory: {
          workMemoryCompressInPrompt: "work_memory_compress_in.md",
          workMemoryCompressOutPrompt: "work_memory_compress_out.md",
          userProfilePrompt: "user_profile_prompt.md"
        },
        orchestrator: {
          promptFile: "user_groupchat_orchestrator.md"
        }
      }
    }), "utf8");

    const config = await loadConfig();

    expect(config.bot.memory.workMemoryCompressInPrompt).toBe("work_memory_compress_in.json");
    expect(config.bot.memory.workMemoryCompressOutPrompt).toBe("work_memory_compress_out.json");
    expect(config.bot.memory.userProfilePrompt).toBe("user_profile_prompt.json");
    expect(config.bot.orchestrator.promptFile).toBe("user_groupchat_orchestrator.json");
  });
});
