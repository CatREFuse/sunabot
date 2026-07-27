import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, ConfigEnvelope, ConfigPatchResponse } from "../types";
import { setActiveAgentId } from "./agentScope";
import { ApiRequestError } from "./useAdminApi";
import { useConfigWorkspace } from "./useConfigWorkspace";

const apiRequest = vi.hoisted(() => vi.fn());

vi.mock("./useAdminApi", () => ({
  ApiRequestError: class ApiRequestError extends Error {
    status: number;
    code: string;
    field?: string;
    constructor(message: string, options: { status: number; code: string; field?: string }) {
      super(message);
      this.status = options.status;
      this.code = options.code;
      this.field = options.field;
    }
  },
  apiRequest,
  apiRequestUnscoped: apiRequest
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function config(adminName: string): AppConfig {
  return {
    schemaVersion: 1,
    server: { host: "127.0.0.1", port: 8787 },
    persona: {
      defaultAgentId: "plana",
      name: "普拉娜",
      agentWorkspace: "workspace/business/agents/plana",
      systemPromptWorkspace: "workspace/business/prompts",
      systemPromptOverride: false
    },
    providers: { defaultProviderId: "codex", items: [] },
    broadcastStorm: { enabled: true, windowMinutes: 2, replyThreshold: 3, cooldownMinutes: 1, additionalQqIds: [] },
    normalReply: { maxRetries: 3 },
    bot: {
      adminQq: "1",
      adminName,
      replyModel: "gpt-5.5",
      replyReasoningEffort: "medium",
      imageReader: {
        enabled: true,
        providerId: "codex",
        model: "gpt-5.4-mini",
        reasoningEffort: "low"
      },
      replyDebounceMs: 5_000,
      pokeOnNoReply: false,
      quoteGroupReplies: true,
      quoteGroupReplyExcludedUserIds: [],
      contextMessageLimit: 48,
      emojiSendSize: 512,
      emojiSendSeparately: false,
      tone: { enabled: false, segmentedReply: false, followMainModel: false, providerId: "", model: "gpt-5.4-mini", reasoningEffort: "low", temperature: 0.7, maxOutputTokens: 2400, maxRetries: 2 },
      director: { enabled: false },
      memory: { memoryModel: "gpt-5.4-mini", reasoningEffort: "medium", messageThreshold: 48, workingMemoryMaxEntries: 100, dreamRecentWindowHours: 48, dreamRecentMemoryLimit: 12, dreamOlderMemoryLimit: 12, workMemoryCompressInPrompt: "in.md", workMemoryCompressOutPrompt: "out.md", userProfilePrompt: "user.md" },
      orchestrator: { enabled: false, userGroupchatOrchestratorModel: "gpt-5.4-mini", groupThreadModel: "gpt-5.4-mini", reasoningEffort: "medium", promptFile: "orchestrator.md", messageThreshold: 10, recentMessageWindowMs: 60_000 },
      tools: {
        maxCalls: 20,
        overrides: {},
        websearch: { provider: "tavily", tavilyApiKey: "", tavilyApiKeys: [], tavilyApiKeyEnv: "TAVILY_API_KEY", maxResults: 5 },
        codex: { enabled: true, model: "gpt-5.4-mini", codexExecutable: "auto", timeoutMs: 900_000, maxConcurrency: 2 },
        generateImg: { provider: "codex-image-gen", size: "1024x1024", resolution: "1K", quality: "high" }
      },
      bash: {
        enabled: true,
        adminPrivateBackend: "docker",
        auditModel: "gpt-5.4-mini",
        strictMode: true,
        allowGroup: false,
        adminOnly: true,
        workspaceOnly: true,
        blockedKeywords: ["rm"]
      }
    },
    onebot: { reverseWsPath: "/onebot/v11/ws", accessTokenEnv: "ONEBOT_ACCESS_TOKEN", autoReplyPrivate: true, autoReplyUserGroup: true, autoReplyBotGroup: false, quoteGroupReplies: true, mentionNames: [], commandPrefixes: [] }
  };
}

function envelope(revision: string, adminName: string): ConfigEnvelope {
  return { revision, config: config(adminName), fieldStates: {} };
}

function patched(revision: string, adminName: string, change?: (value: AppConfig) => void): ConfigPatchResponse {
  const value = envelope(revision, adminName);
  change?.(value.config);
  return { ...value, applyMode: "hot" };
}

describe("useConfigWorkspace", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiRequest.mockReset();
    setActiveAgentId("plana");
  });

  afterEach(() => vi.useRealTimers());

  it("commits a section explicitly and serializes a second confirmed value", async () => {
    const response = deferred<ConfigPatchResponse>();
    apiRequest
      .mockResolvedValueOnce(envelope("r1", "initial"))
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(patched("r3", "typed while saving"));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminName = "submitted";

    const firstCommit = workspace.commit("bot");
    workspace.drafts.bot.adminName = "typed while saving";
    const secondCommit = workspace.commit("bot");
    response.resolve(patched("r2", "submitted"));
    await Promise.all([firstCommit, secondCommit]);

    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body)).value.adminName).toBe("submitted");
    expect(JSON.parse(String(apiRequest.mock.calls[2]?.[1]?.body)).value.adminName).toBe("typed while saving");
    expect(workspace.drafts.bot.adminName).toBe("typed while saving");
    expect(workspace.isDirty("bot")).toBe(false);
    workspace.cancel();
  });

  it("saves a value changed back to the baseline while the previous save is running", async () => {
    const response = deferred<ConfigPatchResponse>();
    apiRequest
      .mockResolvedValueOnce(envelope("r1", "initial"))
      .mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(patched("r3", "initial"));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminName = "submitted";

    const firstCommit = workspace.commit("bot");
    workspace.drafts.bot.adminName = "initial";
    const secondCommit = workspace.commit("bot");
    response.resolve(patched("r2", "submitted"));
    await Promise.all([firstCommit, secondCommit]);

    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body)).value.adminName).toBe("submitted");
    expect(JSON.parse(String(apiRequest.mock.calls[2]?.[1]?.body)).value.adminName).toBe("initial");
    expect(workspace.drafts.bot.adminName).toBe("initial");
    expect(workspace.isDirty("bot")).toBe(false);
    workspace.cancel();
  });

  it("serializes multi-section updates against the latest revision", async () => {
    const first = deferred<ConfigPatchResponse>();
    apiRequest
      .mockResolvedValueOnce(envelope("r1", "initial"))
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(patched("r3", "next", (value) => { value.bot.memory.messageThreshold = 64; }));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminName = "next";
    workspace.drafts.memory.messageThreshold = 64;

    const commits = Promise.all([workspace.commit("bot"), workspace.commit("memory")]);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    first.resolve(patched("r2", "next"));
    await commits;

    expect(apiRequest).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(apiRequest.mock.calls[2]?.[1]?.body)).revision).toBe("r2");
    expect(workspace.isDirty("bot")).toBe(false);
    expect(workspace.isDirty("memory")).toBe(false);
    workspace.cancel();
  });

  it("starts work queued while an empty drain is settling", async () => {
    apiRequest
      .mockResolvedValueOnce(envelope("r1", "initial"))
      .mockResolvedValueOnce(patched("r2", "initial", (value) => { value.bot.bash.enabled = false; }));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bash.enabled = false;

    await Promise.all([workspace.commit("tools"), workspace.commit("bash")]);

    expect(apiRequest).toHaveBeenNthCalledWith(2, "/api/config/bash?agentId=plana", expect.objectContaining({ method: "PATCH" }));
    expect(workspace.isDirty("bash")).toBe(false);
    workspace.cancel();
  });

  it("refreshes the revision and retries one time after a conflict", async () => {
    apiRequest
      .mockResolvedValueOnce(envelope("r1", "initial"))
      .mockRejectedValueOnce(new ApiRequestError("配置已更新。", { status: 409, code: "CONFIG_REVISION_CONFLICT" }))
      .mockResolvedValueOnce(envelope("r2", "server latest"))
      .mockResolvedValueOnce(patched("r3", "local value"));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminName = "local value";

    await workspace.commit("bot");

    expect(apiRequest).toHaveBeenCalledTimes(4);
    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body)).revision).toBe("r1");
    expect(JSON.parse(String(apiRequest.mock.calls[3]?.[1]?.body))).toMatchObject({
      revision: "r2",
      value: { adminName: "local value" }
    });
    expect(workspace.drafts.bot.adminName).toBe("local value");
    expect(workspace.state.bot.kind).toBe("saved");
    workspace.cancel();
  });

  it("stops after one conflict retry and retains the local input", async () => {
    apiRequest
      .mockResolvedValueOnce(envelope("r1", "initial"))
      .mockRejectedValueOnce(new ApiRequestError("冲突。", { status: 409, code: "CONFIG_REVISION_CONFLICT" }))
      .mockResolvedValueOnce(envelope("r2", "server latest"))
      .mockRejectedValueOnce(new ApiRequestError("仍有冲突。", { status: 409, code: "CONFIG_REVISION_CONFLICT" }));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminName = "keep me";

    await workspace.commit("bot");

    expect(apiRequest).toHaveBeenCalledTimes(4);
    expect(workspace.state.bot.kind).toBe("conflict");
    expect(workspace.drafts.bot.adminName).toBe("keep me");
    expect(workspace.isDirty("bot")).toBe(true);
    workspace.cancel();
  });

  it("retains validation errors and the field value in place", async () => {
    apiRequest
      .mockResolvedValueOnce(envelope("r1", "initial"))
      .mockRejectedValueOnce(new ApiRequestError("管理员 QQ 必须是数字。", { status: 400, code: "CONFIG_INVALID", field: "bot.adminQq" }));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminQq = "invalid";

    await workspace.commit("bot");

    expect(workspace.state.bot).toMatchObject({ kind: "error", field: "bot.adminQq" });
    expect(workspace.drafts.bot.adminQq).toBe("invalid");
    expect(await workspace.flush()).toBe(false);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    workspace.cancel();
  });

  it("commits linked group reply fields atomically", async () => {
    apiRequest.mockResolvedValueOnce(envelope("r1", "initial"));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.onebot.autoReplyUserGroup = false;
    workspace.drafts.orchestrator.enabled = true;
    const saved = patched("r2", "initial", (value) => {
      value.onebot.autoReplyUserGroup = false;
      value.bot.orchestrator.enabled = true;
    });
    apiRequest.mockResolvedValueOnce(saved);

    await workspace.commit("orchestrator");

    expect(apiRequest).toHaveBeenNthCalledWith(2, "/api/config/group-reply?agentId=plana", expect.objectContaining({ method: "PATCH" }));
    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body))).toMatchObject({
      revision: "r1",
      value: { enabled: false, orchestrator: { enabled: true } }
    });
    expect(workspace.isGroupReplyDirty()).toBe(false);
    workspace.cancel();
  });

  it("flushes a pending system setting without waiting for the debounce", async () => {
    apiRequest.mockResolvedValueOnce(envelope("r1", "initial"));
    const workspace = useConfigWorkspace("system");
    await workspace.load();
    workspace.drafts.normalReply.maxRetries = 6;
    apiRequest.mockResolvedValueOnce(patched("r2", "initial", (value) => { value.normalReply.maxRetries = 6; }));

    await expect(workspace.flush()).resolves.toBe(true);

    expect(apiRequest).toHaveBeenNthCalledWith(2, "/api/config/normalReply", expect.objectContaining({ method: "PATCH" }));
    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body))).toMatchObject({
      revision: "r1",
      value: { maxRetries: 6 }
    });
    workspace.cancel();
  });

  it("does not save an unconfirmed value before loading another Agent context", async () => {
    apiRequest.mockResolvedValueOnce(envelope("r1", "initial"));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminName = "old Agent pending";
    setActiveAgentId("arona");
    apiRequest.mockResolvedValueOnce(envelope("arona-r1", "arona"));

    await workspace.load();

    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(apiRequest.mock.calls[1]?.[0]).toBe("/api/config?agentId=arona");
    expect(workspace.drafts.bot.adminName).toBe("arona");
    workspace.cancel();
  });

  it("keeps a delayed save alive until an Agent switch flush completes", async () => {
    const delayedSave = deferred<ConfigPatchResponse>();
    apiRequest
      .mockResolvedValueOnce(envelope("r1", "initial"))
      .mockReturnValueOnce(delayedSave.promise)
      .mockResolvedValueOnce(envelope("arona-r1", "arona"));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminName = "saved before switch";

    const flushed = workspace.flush();
    const saveSignal = apiRequest.mock.calls[1]?.[1]?.signal as AbortSignal;
    expect(saveSignal.aborted).toBe(false);
    expect(apiRequest).toHaveBeenCalledTimes(2);

    delayedSave.resolve(patched("r2", "saved before switch"));
    await expect(flushed).resolves.toBe(true);
    expect(saveSignal.aborted).toBe(false);

    await workspace.load({ agentId: "arona" });
    expect(apiRequest.mock.calls[2]?.[0]).toBe("/api/config?agentId=arona");
    expect(workspace.drafts.bot.adminName).toBe("arona");
    workspace.cancel();
  });

  it("normalizes legacy defaults without creating save work", async () => {
    const legacy = envelope("r1", "initial");
    delete (legacy.config as Partial<AppConfig>).normalReply;
    delete (legacy.config.bot as Partial<AppConfig["bot"]>).replyDebounceMs;
    delete (legacy.config.bot.tone as Partial<AppConfig["bot"]["tone"]>).segmentedReply;
    delete (legacy.config.bot.tools as Partial<AppConfig["bot"]["tools"]>).overrides;
    apiRequest.mockResolvedValueOnce(legacy);
    const workspace = useConfigWorkspace();

    await workspace.load();

    expect(workspace.drafts.normalReply).toEqual({ maxRetries: 3 });
    expect(workspace.drafts.bot.replyDebounceMs).toBe(5_000);
    expect(workspace.drafts.tone).toMatchObject({ enabled: false, segmentedReply: false, providerId: "", maxRetries: 2 });
    expect(workspace.drafts.tools.overrides).toEqual({});
    expect(apiRequest).toHaveBeenCalledTimes(1);
    workspace.cancel();
  });
});
