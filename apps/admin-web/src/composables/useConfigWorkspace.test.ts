import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, ConfigEnvelope, ConfigPatchResponse } from "../types";
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
  apiRequest
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function config(adminName: string): AppConfig {
  return {
    server: { host: "127.0.0.1", port: 8787 },
    persona: { defaultAgentId: "plana", agentWorkspace: "workspace/agents/plana", memoryLimit: 100 },
    providers: { defaultProviderId: "codex", items: [] },
    bot: {
      adminQq: "1",
      adminName,
      quoteGroupReplies: true,
      contextMessageLimit: 48,
      memory: { memoryModel: "gpt-5.4-mini", reasoningEffort: "medium", messageThreshold: 48, workingMemoryMaxEntries: 100, workMemoryCompressInPrompt: "in.md", workMemoryCompressOutPrompt: "out.md", userProfilePrompt: "user.md" },
      orchestrator: { enabled: false, userGroupchatOrchestratorModel: "gpt-5.4-mini", reasoningEffort: "medium", promptFile: "orchestrator.md", messageThreshold: 10, recentMessageWindowMs: 60_000 },
      tools: {
        websearch: { provider: "tavily", tavilyApiKey: "", tavilyApiKeys: [], tavilyApiKeyEnv: "TAVILY_API_KEY", maxResults: 5 },
        codex: { enabled: true, model: "gpt-5.4-mini", codexExecutable: "auto", timeoutMs: 900_000, maxConcurrency: 2 },
        generateImg: { provider: "codex-image-gen", size: "1024x1024", resolution: "1K", quality: "high" }
      },
      bash: { enabled: true, allowGroup: false, adminOnly: true, workspaceOnly: true, blockedKeywords: ["rm"] }
    },
    onebot: { reverseWsPath: "/onebot/v11/ws", accessTokenEnv: "ONEBOT_ACCESS_TOKEN", autoReplyPrivate: true, autoReplyUserGroup: true, autoReplyBotGroup: false, quoteGroupReplies: true, mentionNames: [], commandPrefixes: [] }
  };
}

function envelope(revision: string, adminName: string): ConfigEnvelope {
  return { revision, config: config(adminName), fieldStates: {} };
}

describe("useConfigWorkspace", () => {
  beforeEach(() => { apiRequest.mockReset(); });

  it("keeps edits typed while a section save is in flight", async () => {
    const response = deferred<ConfigPatchResponse>();
    apiRequest.mockResolvedValueOnce(envelope("r1", "initial")).mockReturnValueOnce(response.promise);
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminName = "submitted";

    const saving = workspace.save("bot");
    workspace.drafts.bot.adminName = "typed while saving";
    response.resolve({ ...envelope("r2", "submitted"), applyMode: "hot" });
    await saving;

    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body)).value.adminName).toBe("submitted");
    expect(workspace.drafts.bot.adminName).toBe("typed while saving");
    expect(workspace.isDirty("bot")).toBe(true);
    expect(workspace.state.bot.message).toBe("[SAVED · UNSAVED CHANGES]");
    expect(workspace.envelope.value?.revision).toBe("r2");
  });

  it("retains a validation field returned by the server", async () => {
    apiRequest.mockResolvedValueOnce(envelope("r1", "initial"));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminQq = "invalid";
    apiRequest.mockRejectedValueOnce(new ApiRequestError("管理员 QQ 必须是数字。", { status: 400, code: "CONFIG_INVALID", field: "bot.adminQq" }));

    await workspace.save("bot");
    expect(workspace.state.bot).toMatchObject({ kind: "error", field: "bot.adminQq" });
  });

  it("saves the linked user-group and orchestrator controls atomically", async () => {
    apiRequest.mockResolvedValueOnce(envelope("r1", "initial"));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.onebot.autoReplyUserGroup = false;
    workspace.drafts.orchestrator.enabled = true;
    expect(workspace.isOneBotSettingsDirty()).toBe(false);
    const saved = envelope("r2", "initial");
    saved.config.onebot.autoReplyUserGroup = false;
    saved.config.bot.orchestrator.enabled = true;
    apiRequest.mockResolvedValueOnce({ ...saved, applyMode: "hot" });

    await workspace.saveGroupReply();

    expect(apiRequest).toHaveBeenNthCalledWith(2, "/api/config/group-reply", expect.objectContaining({
      method: "PATCH"
    }));
    expect(JSON.parse(String(apiRequest.mock.calls[1]?.[1]?.body))).toMatchObject({
      revision: "r1",
      value: {
        enabled: false,
        orchestrator: { enabled: true }
      }
    });
    expect(workspace.isGroupReplyDirty()).toBe(false);
    expect(workspace.state.orchestrator.kind).toBe("saved");
  });

  it("loads the server version for a conflicted section while preserving other dirty sections", async () => {
    apiRequest.mockResolvedValueOnce(envelope("r1", "initial"));
    const workspace = useConfigWorkspace();
    await workspace.load();
    workspace.drafts.bot.adminName = "local conflict";
    workspace.drafts.memory.messageThreshold = 99;
    apiRequest.mockRejectedValueOnce(new ApiRequestError("配置已更新。", { status: 409, code: "CONFIG_REVISION_CONFLICT" }));
    await workspace.save("bot");
    expect(workspace.state.bot.kind).toBe("conflict");

    apiRequest.mockResolvedValueOnce(envelope("r2", "server latest"));
    await workspace.load({ preserveDirty: true, discardDirtySection: "bot" });
    expect(workspace.drafts.bot.adminName).toBe("server latest");
    expect(workspace.isDirty("bot")).toBe(false);
    expect(workspace.drafts.memory.messageThreshold).toBe(99);
    expect(workspace.isDirty("memory")).toBe(true);
  });
});
