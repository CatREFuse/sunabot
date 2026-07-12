// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/types.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

const configStore = vi.hoisted(() => ({
  config: null as AppConfig | null
}));

vi.mock("../../src/config.js", () => ({
  loadConfig: async () => structuredClone(configStore.config),
  resolveProjectPath: (inputPath: string | undefined) => inputPath
}));

import { AGENT_FILE_DEFINITIONS, AgentFileRepository } from "../../src/admin/agentFiles.js";
import { AdminMutationMutex } from "../../src/admin/mutation.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";

let rootDir = "";
let workspaceDir = "";
let reloadPrompts: ReturnType<typeof vi.fn<(config: AppConfig) => Promise<void>>>;
let repository: AgentFileRepository;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-files-"));
  const config = createAdminTestConfig(rootDir);
  configStore.config = config;
  workspaceDir = config.persona.agentWorkspace;
  await fs.mkdir(workspaceDir, { recursive: true });
  reloadPrompts = vi.fn(async (_config: AppConfig) => undefined);
  repository = new AgentFileRepository({
    runtime: { reloadPrompts },
    mutex: new AdminMutationMutex()
  });
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
  configStore.config = null;
});

describe("AgentFileRepository", () => {
  it("maps all prompt fragments and final request files", async () => {
    const expectedMappings = [
      ["persona.agents", "AGENTS.md"],
      ["persona.soul", "SOUL.md"],
      ["persona.preference", "PREFERENCE.md"],
      ["persona.user", "USER.md"],
      ["persona.relation", "RELATION.md"],
      ["conversation.reply", "conversation_reply.json"],
      ["memory.compress-in", "work_memory_compress_in.json"],
      ["memory.compress-out", "work_memory_compress_out.json"],
      ["memory.user-profile", "user_profile_prompt.json"],
      ["orchestrator.user-group", "user_groupchat_orchestrator.json"],
      ["conversation.group-summary", "group_chat_summary.json"],
      ["image.selfie-rewrite", "selfie_prompt_rewrite.json"]
    ] as const;
    for (const [id, fileName] of expectedMappings) {
      const definition = AGENT_FILE_DEFINITIONS.find((item) => item.id === id)!;
      const content = definition.kind === "final" ? defaultPromptContent(id) : `${id}\n`;
      await fs.writeFile(path.join(workspaceDir, fileName), content, "utf8");
    }

    const result = await repository.list();

    expect(result.files.map(({ id, fileName }) => [id, fileName])).toEqual(expectedMappings);
    await expect(repository.get("persona.agents")).resolves.toMatchObject({
      fileName: "AGENTS.md",
      kind: "fragment",
      content: "persona.agents\n"
    });
  });

  it("saves atomically, reloads prompts and protects against a stale revision", async () => {
    const filePath = path.join(workspaceDir, "SOUL.md");
    await fs.writeFile(filePath, "original\n", "utf8");
    const current = await repository.get("persona.soul");

    const saved = await repository.put("persona.soul", {
      content: "updated soul\n",
      revision: current.revision
    });

    expect(saved).toMatchObject({
      ok: true,
      id: "persona.soul",
      content: "updated soul\n",
      empty: false
    });
    expect(saved.revision).not.toBe(current.revision);
    expect(await fs.readFile(filePath, "utf8")).toBe("updated soul\n");
    expect(reloadPrompts).toHaveBeenCalledOnce();
    expect(await fs.readdir(workspaceDir)).toEqual(["SOUL.md"]);

    await expect(repository.put("persona.soul", {
      content: "stale writer\n",
      revision: current.revision
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "AGENT_FILE_REVISION_CONFLICT",
      latestRevision: saved.revision
    });
    expect(await fs.readFile(filePath, "utf8")).toBe("updated soul\n");
  });

  it("accepts raw MD fragments and requires valid non-empty final JSON", async () => {
    const persona = await repository.get("persona.preference");
    await expect(repository.put("persona.preference", {
      content: " \n",
      revision: persona.revision
    })).rejects.toMatchObject({ code: "AGENT_FILE_EMPTY", field: "content" });
    const savedPersona = await repository.put("persona.preference", {
      content: "# 直接可用的 Markdown\n",
      revision: persona.revision
    });
    expect(savedPersona.content).toBe("# 直接可用的 Markdown\n");
    const currentPersona = await repository.get("persona.preference");
    await expect(repository.put("persona.preference", {
      content: "@{unknown.variable}\n",
      revision: currentPersona.revision
    })).rejects.toMatchObject({ code: "PROMPT_VARIABLE_UNKNOWN", field: "unknown.variable" });

    const promptPath = path.join(workspaceDir, "work_memory_compress_in.json");
    await fs.writeFile(promptPath, defaultPromptContent("memory.compress-in"), "utf8");
    const prompt = await repository.get("memory.compress-in");
    await expect(repository.put("memory.compress-in", {
      content: "  \n",
      revision: prompt.revision
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "AGENT_FILE_EMPTY",
      field: "content"
    });
    await expect(repository.put("memory.compress-in", {
      content: "{\"messages\": []}\n",
      revision: prompt.revision
    })).rejects.toMatchObject({ code: "PROMPT_MESSAGES_INVALID", field: "messages" });

    const conversationPath = path.join(workspaceDir, "conversation_reply.json");
    await fs.writeFile(conversationPath, defaultPromptContent("conversation.reply"), "utf8");
    const conversation = await repository.get("conversation.reply");
    const wrongGroup = JSON.parse(conversation.content);
    wrongGroup.messages[1] = "@{user.input}";
    await expect(repository.put("conversation.reply", {
      content: `${JSON.stringify(wrongGroup, null, 2)}\n`,
      revision: conversation.revision
    })).rejects.toMatchObject({ code: "PROMPT_MESSAGE_GROUP_TYPE_INVALID", field: "user.input" });
    expect(await fs.readFile(promptPath, "utf8")).toBe(defaultPromptContent("memory.compress-in"));
  });

  it("edits the user profile extraction prompt with persona variables", async () => {
    const filePath = path.join(workspaceDir, "user_profile_prompt.json");
    await fs.writeFile(filePath, defaultPromptContent("memory.user-profile"), "utf8");
    const current = await repository.get("memory.user-profile");
    const document = JSON.parse(current.content);
    document.messages[0].content = `<soul>@{persona.soul}</soul>\n${document.messages[0].content}`;

    const saved = await repository.put("memory.user-profile", {
      content: `${JSON.stringify(document, null, 2)}\n`,
      revision: current.revision
    });

    expect(saved.content).toContain("@{persona.soul}");
    expect(await fs.readFile(filePath, "utf8")).toContain("@{persona.soul}");
  });

  it("resolves the current dynamic prompt path on every operation", async () => {
    const config = currentConfig();
    config.bot.memory.workMemoryCompressInPrompt = "nested/compress.json";
    configStore.config = config;
    await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "nested/compress.json"), defaultPromptContent("memory.compress-in"), "utf8");

    await expect(repository.get("memory.compress-in")).resolves.toMatchObject({
      fileName: "nested/compress.json",
      kind: "final"
    });
  });

  it("rejects lexical traversal and an existing symlink that leaves the workspace", async () => {
    const traversingConfig = currentConfig();
    traversingConfig.bot.memory.workMemoryCompressInPrompt = "../outside.json";
    configStore.config = traversingConfig;
    await expect(repository.get("memory.compress-in")).rejects.toMatchObject({
      statusCode: 400,
      code: "AGENT_FILE_PATH_INVALID"
    });

    const outsideDir = path.join(rootDir, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(workspaceDir, "linked"));
    const symlinkConfig = currentConfig();
    symlinkConfig.bot.memory.workMemoryCompressInPrompt = "linked/prompt.json";
    configStore.config = symlinkConfig;
    await expect(repository.get("memory.compress-in")).rejects.toMatchObject({
      statusCode: 400,
      code: "AGENT_FILE_PATH_INVALID"
    });
  });

  it("returns a reusable revision when a safe parent symlink stays inside the workspace", async () => {
    const realDir = path.join(workspaceDir, "real");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, path.join(workspaceDir, "linked"));
    await fs.writeFile(path.join(realDir, "prompt.json"), finalPrompt("first"), "utf8");
    const config = currentConfig();
    config.bot.memory.workMemoryCompressInPrompt = "linked/prompt.json";
    configStore.config = config;

    const current = await repository.get("memory.compress-in");
    const first = await repository.put("memory.compress-in", {
      content: finalPrompt("second"),
      revision: current.revision
    });
    const second = await repository.put("memory.compress-in", {
      content: finalPrompt("third"),
      revision: first.revision
    });

    expect(second.content).toBe(finalPrompt("third"));
    expect(await fs.readFile(path.join(realDir, "prompt.json"), "utf8")).toBe(finalPrompt("third"));
  });

  it("validates a missing workspace without creating it", async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });

    await expect(repository.validateConfig(currentConfig())).resolves.toBeUndefined();
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an external edit made while prompt reload is being prepared", async () => {
    const filePath = path.join(workspaceDir, "SOUL.md");
    await fs.writeFile(filePath, "original\n", "utf8");
    const current = await repository.get("persona.soul");
    const commitPromptReload = vi.fn();
    const preparePromptReload = vi.fn(async () => {
      await fs.writeFile(filePath, "external edit\n", "utf8");
      return { prepared: true };
    });
    const raceAwareRepository = new AgentFileRepository({
      runtime: {
        reloadPrompts,
        preparePromptReload,
        commitPromptReload
      },
      mutex: new AdminMutationMutex()
    });

    await expect(raceAwareRepository.put("persona.soul", {
      content: "admin edit\n",
      revision: current.revision
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "AGENT_FILE_REVISION_CONFLICT"
    });

    expect(preparePromptReload).toHaveBeenCalledOnce();
    expect(commitPromptReload).not.toHaveBeenCalled();
    expect(reloadPrompts).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf8")).toBe("external edit\n");
    expect(await fs.readdir(workspaceDir)).toEqual(["SOUL.md"]);
  });
});

function currentConfig() {
  if (!configStore.config) throw new Error("Test config is not initialized.");
  return structuredClone(configStore.config);
}

function finalPrompt(system: string) {
  return `${JSON.stringify({
    messages: [{ role: "system", content: system }, { role: "user", content: "@{memory.payload}" }],
    tools: [],
    response_format: { type: "text" }
  }, null, 2)}\n`;
}
