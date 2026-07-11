// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig } from "../../src/config.js";

let rootDir = "";
let configPath = "";
let originalConfigPath: string | undefined;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-config-load-"));
  configPath = path.join(rootDir, "sunabot.json");
  originalConfigPath = process.env.SUNABOT_CONFIG;
  process.env.SUNABOT_CONFIG = configPath;
});

afterEach(async () => {
  if (originalConfigPath == null) delete process.env.SUNABOT_CONFIG;
  else process.env.SUNABOT_CONFIG = originalConfigPath;
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe("tool configuration", () => {
  it("defaults websearch to Tavily and Codex to an independent worker", () => {
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
