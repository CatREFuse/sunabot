// @vitest-environment node
import crypto from "node:crypto";
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

import {
  AGENT_FILE_BATCH_TRANSACTION_FILE,
  AGENT_FILE_DEFINITIONS,
  AgentFileRepository,
  recoverAgentFileBatchTransactions
} from "../../src/admin/agentFiles.js";
import { AdminMutationMutex, AdminRecoveryState } from "../../src/admin/mutation.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";

let rootDir = "";
let workspaceDir = "";
let reloadPrompts: ReturnType<typeof vi.fn<(config: AppConfig) => Promise<void>>>;
let repository: AgentFileRepository;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-agent-files-"));
  const config = createAdminTestConfig(rootDir);
  workspaceDir = config.persona.agentWorkspace;
  config.persona.systemPromptWorkspace = workspaceDir;
  configStore.config = config;
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
  it("keeps persona files in the Agent workspace and system prompts in the configured shared workspace", async () => {
    const config = currentConfig();
    const systemPromptWorkspace = path.join(rootDir, "shared-prompts");
    config.persona.systemPromptWorkspace = systemPromptWorkspace;
    configStore.config = config;
    await fs.mkdir(systemPromptWorkspace, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "Agent persona\n", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "selfie_prompt_rewrite.json"),
      defaultPromptContent("image.selfie-rewrite"),
      "utf8"
    );
    await fs.writeFile(
      path.join(systemPromptWorkspace, "conversation_private_reply.json"),
      defaultPromptContent("conversation.private-reply"),
      "utf8"
    );

    await expect(repository.get("persona.soul")).resolves.toMatchObject({ content: "Agent persona\n" });
    await expect(repository.get("conversation.private-reply")).resolves.toMatchObject({
      content: defaultPromptContent("conversation.private-reply")
    });
    const personaFiles = (await repository.list(config, "persona")).files;
    const systemFiles = (await repository.list(config, "system")).files;
    expect(personaFiles.filter((file) => file.kind === "fragment")).toHaveLength(8);
    expect(personaFiles).toContainEqual(expect.objectContaining({ id: "image.selfie-rewrite", kind: "final" }));
    expect(systemFiles).not.toContainEqual(expect.objectContaining({ id: "image.selfie-rewrite" }));
  });

  it("maps all prompt fragments and final request files", async () => {
    const expectedMappings = [
      ["persona.agents", "AGENTS.md"],
      ["persona.soul", "SOUL.md"],
      ["persona.preference", "PREFERENCE.md"],
      ["persona.dialogue_style_examples", "DIALOGUE_STYLE_EXAMPLES.md"],
      ["persona.user", "USER.md"],
      ["persona.relation", "RELATION.md"],
      ["persona.air", "AIR.md"],
      ["persona.director-seed", "DIRECTOR_SEED.md"],
      ["conversation.private-reply", "conversation_private_reply.json"],
      ["conversation.group-reply", "conversation_group_reply.json"],
      ["conversation.tone-rewrite", "tone_rewrite.json"],
      ["memory.compress-out", "work_memory_compress_out.json"],
      ["memory.dream", "memory_dream.json"],
      ["orchestrator.user-group", "user_groupchat_orchestrator.json"],
      ["conversation.group-summary", "group_chat_summary.json"],
      ["scheduler.cron-callback", "cron_callback.json"],
      ["director.daily-plan", "director_daily_plan.json"],
      ["director.schedule-revision", "director_schedule_revision.json"],
      ["air.read", "read_air.json"],
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

  it("commits a persona batch with one reload and rejects a stale batch revision", async () => {
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "old soul\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "old user\n", "utf8");
    const snapshot = await repository.readBatch(currentConfig(), "persona");

    const saved = await repository.putBatch([
      { id: "persona.soul", content: "new soul\n" },
      { id: "persona.user", content: "new user\n" }
    ], snapshot.revision, currentConfig(), "persona");

    expect(saved.revision).not.toBe(snapshot.revision);
    expect(reloadPrompts).toHaveBeenCalledOnce();
    expect(await fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf8")).toBe("new soul\n");
    expect(await fs.readFile(path.join(workspaceDir, "USER.md"), "utf8")).toBe("new user\n");
    expect((await fs.readdir(workspaceDir)).filter((fileName) => fileName.includes("admin-backup") || fileName.endsWith(".tmp"))).toEqual([]);

    await expect(repository.putBatch([
      { id: "persona.soul", content: "stale soul\n" }
    ], snapshot.revision, currentConfig(), "persona")).rejects.toMatchObject({
      statusCode: 409,
      code: "AGENT_FILE_BATCH_REVISION_CONFLICT"
    });
  });

  it("rolls back every persona file when the batch reload fails", async () => {
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "old soul\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "old user\n", "utf8");
    const snapshot = await repository.readBatch(currentConfig(), "persona");
    reloadPrompts.mockRejectedValueOnce(new Error("reload failed")).mockResolvedValueOnce(undefined);

    await expect(repository.putBatch([
      { id: "persona.soul", content: "new soul\n" },
      { id: "persona.user", content: "new user\n" }
    ], snapshot.revision, currentConfig(), "persona")).rejects.toThrow("reload failed");

    expect(reloadPrompts).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf8")).toBe("old soul\n");
    expect(await fs.readFile(path.join(workspaceDir, "USER.md"), "utf8")).toBe("old user\n");
    expect((await fs.readdir(workspaceDir)).filter((fileName) => fileName.includes("admin-backup") || fileName.endsWith(".tmp"))).toEqual([]);
  });

  it("rolls back an earlier persona rename when a later rename fails", async () => {
    const soulPath = path.join(workspaceDir, "SOUL.md");
    const userPath = path.join(workspaceDir, "USER.md");
    await fs.writeFile(soulPath, "old soul\n", "utf8");
    await fs.writeFile(userPath, "old user\n", "utf8");
    const snapshot = await repository.readBatch(currentConfig(), "persona");
    const rename = fs.rename.bind(fs);
    let failed = false;
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (!failed && String(source).includes(".tmp") && String(destination).endsWith(`${path.sep}USER.md`)) {
        failed = true;
        throw new Error("rename failed");
      }
      return rename(source, destination);
    });

    try {
      await expect(repository.putBatch([
        { id: "persona.soul", content: "new soul\n" },
        { id: "persona.user", content: "new user\n" }
      ], snapshot.revision, currentConfig(), "persona")).rejects.toThrow("rename failed");
    } finally {
      renameSpy.mockRestore();
    }

    expect(reloadPrompts).toHaveBeenCalledOnce();
    expect(await fs.readFile(soulPath, "utf8")).toBe("old soul\n");
    expect(await fs.readFile(userPath, "utf8")).toBe("old user\n");
    expect((await fs.readdir(workspaceDir)).filter((fileName) => fileName.includes("admin-backup") || fileName.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves every persona file untouched when backup preparation fails", async () => {
    const soulPath = path.join(workspaceDir, "SOUL.md");
    const userPath = path.join(workspaceDir, "USER.md");
    await fs.writeFile(soulPath, "old soul\n", "utf8");
    await fs.writeFile(userPath, "old user\n", "utf8");
    const snapshot = await repository.readBatch(currentConfig(), "persona");
    const open = fs.open.bind(fs);
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
      if (String(file).includes("USER.md") && String(file).endsWith(".admin-backup")) {
        throw new Error("backup failed");
      }
      return open(file, flags, mode);
    });

    try {
      await expect(repository.putBatch([
        { id: "persona.soul", content: "new soul\n" },
        { id: "persona.user", content: "new user\n" }
      ], snapshot.revision, currentConfig(), "persona")).rejects.toThrow("backup failed");
    } finally {
      openSpy.mockRestore();
    }

    expect(reloadPrompts).not.toHaveBeenCalled();
    expect(await fs.readFile(soulPath, "utf8")).toBe("old soul\n");
    expect(await fs.readFile(userPath, "utf8")).toBe("old user\n");
    expect((await fs.readdir(workspaceDir)).filter((fileName) => fileName.includes("admin-backup") || fileName.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves an external edit detected after the batch journal is durable", async () => {
    const soulPath = path.join(workspaceDir, "SOUL.md");
    await fs.writeFile(soulPath, "old soul\n", "utf8");
    const snapshot = await repository.readBatch(currentConfig(), "persona");
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (String(destination).endsWith(AGENT_FILE_BATCH_TRANSACTION_FILE)) {
        await fs.writeFile(soulPath, "external edit\n", "utf8");
      }
    });

    try {
      await expect(repository.putBatch([
        { id: "persona.soul", content: "new soul\n" }
      ], snapshot.revision, currentConfig(), "persona")).rejects.toMatchObject({
        code: "AGENT_FILE_BATCH_REVISION_CONFLICT",
        statusCode: 409
      });
    } finally {
      renameSpy.mockRestore();
    }

    expect(await fs.readFile(soulPath, "utf8")).toBe("external edit\n");
    expect(reloadPrompts).not.toHaveBeenCalled();
    expect((await fs.readdir(workspaceDir)).filter((fileName) => (
      fileName.includes("admin-backup")
      || fileName.endsWith(".tmp")
      || fileName === AGENT_FILE_BATCH_TRANSACTION_FILE
    ))).toEqual([]);
  });

  it("restores a prepared persona transaction after an interrupted partial rename", async () => {
    const transactionId = "0123456789abcdef01234567";
    const soulPath = path.join(workspaceDir, "SOUL.md");
    const userPath = path.join(workspaceDir, "USER.md");
    await fs.writeFile(soulPath, "new soul\n", "utf8");
    await fs.writeFile(userPath, "old user\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, `.SOUL.md.${transactionId}.admin-backup`), "old soul\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, `.USER.md.${transactionId}.admin-backup`), "old user\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, `.USER.md.${transactionId}.tmp`), "new user\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, AGENT_FILE_BATCH_TRANSACTION_FILE), `${JSON.stringify({
      schema: "sunabot.agent-files-transaction",
      version: 1,
      transactionId,
      phase: "prepared",
      scope: "persona",
      targets: [
        {
          id: "persona.soul",
          fileName: "SOUL.md",
          existed: true,
          originalSha256: digest("old soul\n"),
          nextSha256: digest("new soul\n")
        },
        {
          id: "persona.user",
          fileName: "USER.md",
          existed: true,
          originalSha256: digest("old user\n"),
          nextSha256: digest("new user\n")
        }
      ]
    })}\n`, "utf8");

    await expect(recoverAgentFileBatchTransactions(currentConfig())).resolves.toBeUndefined();

    expect(await fs.readFile(soulPath, "utf8")).toBe("old soul\n");
    expect(await fs.readFile(userPath, "utf8")).toBe("old user\n");
    expect(reloadPrompts).not.toHaveBeenCalled();
    expect((await fs.readdir(workspaceDir)).filter((fileName) => (
      fileName.includes(transactionId) || fileName === AGENT_FILE_BATCH_TRANSACTION_FILE
    ))).toEqual([]);
  });

  it("keeps a committed persona transaction while cleaning crash artifacts", async () => {
    const transactionId = "89abcdef0123456789abcdef";
    const soulPath = path.join(workspaceDir, "SOUL.md");
    await fs.writeFile(soulPath, "new soul\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, `.SOUL.md.${transactionId}.admin-backup`), "old soul\n", "utf8");
    await fs.writeFile(path.join(workspaceDir, AGENT_FILE_BATCH_TRANSACTION_FILE), `${JSON.stringify({
      schema: "sunabot.agent-files-transaction",
      version: 1,
      transactionId,
      phase: "committed",
      scope: "persona",
      targets: [{
        id: "persona.soul",
        fileName: "SOUL.md",
        existed: true,
        originalSha256: digest("old soul\n"),
        nextSha256: digest("new soul\n")
      }]
    })}\n`, "utf8");

    await expect(repository.readBatch(currentConfig(), "persona")).resolves.toBeDefined();

    expect(await fs.readFile(soulPath, "utf8")).toBe("new soul\n");
    expect(reloadPrompts).toHaveBeenCalledOnce();
    expect((await fs.readdir(workspaceDir)).filter((fileName) => (
      fileName.includes(transactionId) || fileName === AGENT_FILE_BATCH_TRANSACTION_FILE
    ))).toEqual([]);
  });

  it("enters recovery state when the restored persona batch cannot reload", async () => {
    const recoveryState = new AdminRecoveryState();
    const failingReload = vi.fn(async () => {
      throw new Error("runtime unavailable");
    });
    const guardedRepository = new AgentFileRepository({
      runtime: { reloadPrompts: failingReload },
      mutex: new AdminMutationMutex(),
      recoveryState
    });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "old soul\n", "utf8");
    const snapshot = await guardedRepository.readBatch(currentConfig(), "persona");

    await expect(guardedRepository.putBatch([
      { id: "persona.soul", content: "new soul\n" }
    ], snapshot.revision, currentConfig(), "persona")).rejects.toMatchObject({
      statusCode: 503,
      code: "CONFIG_RECOVERY_REQUIRED"
    });

    expect(failingReload).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(path.join(workspaceDir, "SOUL.md"), "utf8")).toBe("old soul\n");
    expect(recoveryState.get()).toContain("人格文件批量提交失败且自动恢复失败");
    await expect(guardedRepository.putBatch([
      { id: "persona.soul", content: "another soul\n" }
    ], snapshot.revision, currentConfig(), "persona")).rejects.toMatchObject({
      statusCode: 503,
      code: "CONFIG_RECOVERY_REQUIRED"
    });
  });

  it("rolls back a persona file when its lifecycle is aborted after the atomic rename", async () => {
    const filePath = path.join(workspaceDir, "PREFERENCE.md");
    await fs.writeFile(filePath, "original preference\n", "utf8");
    const current = await repository.get("persona.preference");
    const controller = new AbortController();
    const commitPromptReload = vi.fn(() => {
      controller.abort(new DOMException("Runtime closed.", "AbortError"));
    });
    const abortAwareRepository = new AgentFileRepository({
      runtime: {
        reloadPrompts,
        preparePromptReload: vi.fn(async () => ({ prepared: true })),
        commitPromptReload
      },
      mutex: new AdminMutationMutex()
    });

    await expect(abortAwareRepository.put("persona.preference", {
      content: "late dream preference\n",
      revision: current.revision
    }, currentConfig(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(commitPromptReload).toHaveBeenCalledOnce();
    expect(reloadPrompts).toHaveBeenCalledOnce();
    expect(await fs.readFile(filePath, "utf8")).toBe("original preference\n");
    expect(await fs.readdir(workspaceDir)).toEqual(["PREFERENCE.md"]);
  });

  it("saves system prompts without replacing an Agent runtime configuration", async () => {
    const filePath = path.join(workspaceDir, "conversation_private_reply.json");
    await fs.writeFile(filePath, defaultPromptContent("conversation.private-reply"), "utf8");
    const current = await repository.get("conversation.private-reply");
    const preparePromptReload = vi.fn(async () => ({ prepared: true }));
    const commitPromptReload = vi.fn();
    const systemRepository = new AgentFileRepository({
      runtime: { reloadPrompts, preparePromptReload, commitPromptReload },
      mutex: new AdminMutationMutex()
    });
    const document = JSON.parse(current.content);
    document.messages[0].content = `${document.messages[0].content}\n公共系统提示词更新`;

    await systemRepository.put("conversation.private-reply", {
      content: `${JSON.stringify(document, null, 2)}\n`,
      revision: current.revision
    });

    expect(preparePromptReload).not.toHaveBeenCalled();
    expect(commitPromptReload).not.toHaveBeenCalled();
    expect(reloadPrompts).not.toHaveBeenCalled();
    expect(await fs.readFile(filePath, "utf8")).toContain("公共系统提示词更新");
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

    const promptPath = path.join(workspaceDir, "work_memory_compress_out.json");
    await fs.writeFile(promptPath, defaultPromptContent("memory.compress-out"), "utf8");
    const prompt = await repository.get("memory.compress-out");
    await expect(repository.put("memory.compress-out", {
      content: "  \n",
      revision: prompt.revision
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "AGENT_FILE_EMPTY",
      field: "content"
    });
    await expect(repository.put("memory.compress-out", {
      content: "{\"messages\": []}\n",
      revision: prompt.revision
    })).rejects.toMatchObject({ code: "PROMPT_MESSAGES_INVALID", field: "messages" });

    const conversationPath = path.join(workspaceDir, "conversation_private_reply.json");
    await fs.writeFile(conversationPath, defaultPromptContent("conversation.private-reply"), "utf8");
    const conversation = await repository.get("conversation.private-reply");
    const wrongGroup = JSON.parse(conversation.content);
    wrongGroup.messages[1] = "@{user.input}";
    await expect(repository.put("conversation.private-reply", {
      content: `${JSON.stringify(wrongGroup, null, 2)}\n`,
      revision: conversation.revision
    })).rejects.toMatchObject({ code: "PROMPT_MESSAGE_GROUP_TYPE_INVALID", field: "user.input" });
    expect(await fs.readFile(promptPath, "utf8")).toBe(defaultPromptContent("memory.compress-out"));
  });

  it("resolves the current dynamic prompt path on every operation", async () => {
    const config = currentConfig();
    config.bot.memory.workMemoryCompressOutPrompt = "nested/compress.json";
    configStore.config = config;
    await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "nested/compress.json"), defaultPromptContent("memory.compress-out"), "utf8");

    await expect(repository.get("memory.compress-out")).resolves.toMatchObject({
      fileName: "nested/compress.json",
      kind: "final"
    });
  });

  it("rejects lexical traversal and an existing symlink that leaves the workspace", async () => {
    const traversingConfig = currentConfig();
    traversingConfig.bot.memory.workMemoryCompressOutPrompt = "../outside.json";
    configStore.config = traversingConfig;
    await expect(repository.get("memory.compress-out")).rejects.toMatchObject({
      statusCode: 400,
      code: "AGENT_FILE_PATH_INVALID"
    });

    const outsideDir = path.join(rootDir, "outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(workspaceDir, "linked"));
    const symlinkConfig = currentConfig();
    symlinkConfig.bot.memory.workMemoryCompressOutPrompt = "linked/prompt.json";
    configStore.config = symlinkConfig;
    await expect(repository.get("memory.compress-out")).rejects.toMatchObject({
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
    config.bot.memory.workMemoryCompressOutPrompt = "linked/prompt.json";
    configStore.config = config;

    const current = await repository.get("memory.compress-out");
    const first = await repository.put("memory.compress-out", {
      content: finalPrompt("second"),
      revision: current.revision
    });
    const second = await repository.put("memory.compress-out", {
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

function digest(content: string) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}
