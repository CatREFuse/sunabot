// @vitest-environment happy-dom
import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAgentId } from "./agentScope";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

import { useConversationSettings } from "./useConversationSettings";

describe("useConversationSettings", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    setActiveAgentId("plana");
  });

  it("loads and saves reply, orchestrator and tool settings for one QQ conversation", async () => {
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/conversations") return Promise.resolve({ conversations: [groupConversation()] });
      if (path === "/api/tools") return Promise.resolve({ tools: [
        { name: "read_file", title: "读取文件", description: "读取文件", enabled: true },
        { name: "codex", title: "Codex", description: "执行任务", enabled: true }
      ] });
      if (path === "/api/conversations/group%3A7/tools" && init?.method === "PUT") {
        return Promise.resolve({ conversationId: "group:7", disabledTools: ["codex"] });
      }
      if (path === "/api/conversations/group%3A7/tools") {
        return Promise.resolve({ conversationId: "group:7", disabledTools: ["read_file"] });
      }
      if (path === "/api/conversations/reply" && init?.method === "PUT") {
        return Promise.resolve({ conversation: { ...groupConversation(), replyEnabled: false, orchestratorEnabled: false } });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings("group:7");

    await expect(state.load()).resolves.toBe(true);
    expect(state.conversation.value?.title).toBe("群聊");
    expect(state.disabledTools.value).toEqual(["read_file"]);
    expect(state.supportsOrchestrator.value).toBe(true);

    state.setReplyEnabled(false);
    state.setOrchestratorEnabled(false);
    expect(state.behaviorDirty.value).toBe(true);
    await expect(state.saveBehavior()).resolves.toBe(true);
    expect(JSON.parse(apiRequest.mock.calls.find(([path]) => path === "/api/conversations/reply")?.[1]?.body)).toMatchObject({
      id: "group:7",
      replyEnabled: false,
      orchestratorEnabled: false
    });
    expect(state.behaviorDirty.value).toBe(false);

    state.setToolEnabled("read_file", true);
    state.setToolEnabled("codex", false);
    expect(state.toolsDirty.value).toBe(true);
    await expect(state.saveTools()).resolves.toBe(true);
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/conversations/group%3A7/tools",
      { method: "PUT", body: JSON.stringify({ disabledTools: ["codex"] }) }
    );
    expect(state.toolsDirty.value).toBe(false);
  });

  it("gives Web Chat the same isolated tool page without QQ reply settings", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/tools") return Promise.resolve({
        tools: [{ name: "read_file", title: "读取文件", description: "读取文件", enabled: true }]
      });
      if (path === "/api/conversations/web%3Aadmin/tools") {
        return Promise.resolve({ conversationId: "web:admin", disabledTools: [] });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings("web:admin");

    await expect(state.load()).resolves.toBe(true);

    expect(state.conversation.value).toMatchObject({ id: "web:admin", title: "Web Chat" });
    expect(state.supportsBehavior.value).toBe(false);
    expect(apiRequest).not.toHaveBeenCalledWith("/api/conversations");
  });

  it("reports a missing QQ conversation without creating settings for it", async () => {
    apiRequest.mockResolvedValue({ conversations: [] });
    const state = useConversationSettings("private:999");

    await expect(state.load()).resolves.toBe(false);

    expect(state.conversation.value).toBeNull();
    expect(state.loadError.value).toBe("会话不存在");
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps QQ reply settings available when the tool catalog cannot load", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/conversations") return Promise.resolve({ conversations: [groupConversation()] });
      if (path === "/api/tools") return Promise.reject(new Error("工具目录不可用"));
      if (path === "/api/conversations/group%3A7/tools") {
        return Promise.resolve({ conversationId: "group:7", disabledTools: [] });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings("group:7");

    await expect(state.load()).resolves.toBe(false);

    expect(state.conversation.value?.id).toBe("group:7");
    expect(state.supportsBehavior.value).toBe(true);
    expect(state.loadError.value).toBe("");
    expect(state.toolError.value).toBe("工具目录不可用");
  });

  it("clears the previous conversation and ignores its late save when the route ID changes", async () => {
    const conversationId = ref("private:1");
    let listReads = 0;
    let resolveFirstSave: ((value: unknown) => void) | undefined;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/conversations") {
        listReads += 1;
        const id = listReads === 1 ? "private:1" : "private:2";
        return Promise.resolve({ conversations: [privateConversation(id)] });
      }
      if (path === "/api/tools") return Promise.resolve({ tools: [
        { name: "read_file", title: "读取文件", description: "读取文件", enabled: true }
      ] });
      if (path === "/api/conversations/private%3A1/tools") {
        return Promise.resolve({ conversationId: "private:1", disabledTools: [] });
      }
      if (path === "/api/conversations/private%3A2/tools") {
        return Promise.resolve({ conversationId: "private:2", disabledTools: ["read_file"] });
      }
      if (path === "/api/conversations/reply" && init?.method === "PUT") {
        return new Promise((resolve) => { resolveFirstSave = resolve; });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings(conversationId);
    await state.load();
    state.setReplyEnabled(false);
    const firstSave = state.saveBehavior();

    conversationId.value = "private:2";
    const secondLoad = state.load();
    expect(state.conversation.value).toBeNull();
    expect(state.behaviorSaving.value).toBe(false);
    await expect(secondLoad).resolves.toBe(true);
    expect(state.conversation.value?.id).toBe("private:2");
    expect(state.disabledTools.value).toEqual(["read_file"]);

    resolveFirstSave?.({ conversation: { ...privateConversation("private:1"), replyEnabled: false } });
    await expect(firstSave).resolves.toBe(true);
    expect(state.conversation.value?.id).toBe("private:2");
    expect(state.replyEnabled.value).toBe(true);
  });

  it("refuses to save old conversation drafts after the active Agent changes", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (path === "/api/conversations") return Promise.resolve({ conversations: [groupConversation()] });
      if (path === "/api/tools") return Promise.resolve({ tools: [
        { name: "read_file", title: "读取文件", description: "读取文件", enabled: true }
      ] });
      if (path === "/api/conversations/group%3A7/tools") {
        return Promise.resolve({ conversationId: "group:7", disabledTools: [] });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings("group:7");
    await state.load();
    state.setReplyEnabled(false);
    state.setToolEnabled("read_file", false);

    setActiveAgentId("arona");

    await expect(state.saveBehavior()).resolves.toBe(false);
    await expect(state.saveTools()).resolves.toBe(false);
    expect(state.behaviorError.value).toBe("Agent 已切换，请刷新页面");
    expect(state.toolError.value).toBe("Agent 已切换，请刷新页面");
    expect(apiRequest.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
  });

  it("does not expose or save the previous tool policy while the next conversation is loading", async () => {
    const conversationId = ref("private:1");
    const secondPolicy = deferred<{ conversationId: string; disabledTools: string[] }>();
    let listReads = 0;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/conversations") {
        listReads += 1;
        const id = listReads === 1 ? "private:1" : "private:2";
        return Promise.resolve({ conversations: [privateConversation(id)] });
      }
      if (path === "/api/tools") return Promise.resolve({ tools: [
        { name: "read_file", title: "读取文件", description: "读取文件", enabled: true }
      ] });
      if (path === "/api/conversations/private%3A1/tools") {
        return Promise.resolve({ conversationId: "private:1", disabledTools: [] });
      }
      if (path === "/api/conversations/private%3A2/tools" && init?.method === "PUT") {
        throw new Error("tool policy must not save before load");
      }
      if (path === "/api/conversations/private%3A2/tools") return secondPolicy.promise;
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings(conversationId);
    await state.load();

    conversationId.value = "private:2";
    const secondLoad = state.load();
    await vi.waitFor(() => expect(state.conversation.value?.id).toBe("private:2"));
    expect(state.toolsReady.value).toBe(false);
    expect(state.tools.value).toEqual([]);
    expect(state.toolsDirty.value).toBe(false);
    await expect(state.saveTools()).resolves.toBe(false);

    secondPolicy.resolve({ conversationId: "private:2", disabledTools: ["read_file"] });
    await expect(secondLoad).resolves.toBe(true);
    expect(state.toolsReady.value).toBe(true);
    expect(state.disabledTools.value).toEqual(["read_file"]);
    expect(state.toolError.value).toBe("");
    expect(apiRequest.mock.calls.filter(([path, init]) => path === "/api/conversations/private%3A2/tools" && init?.method === "PUT")).toHaveLength(0);
  });

  it("does not show a late reply save failure after the conversation ID changes", async () => {
    const conversationId = ref("private:1");
    const firstSave = deferred<{ conversation: ReturnType<typeof privateConversation> }>();
    let listReads = 0;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (path === "/api/conversations") {
        listReads += 1;
        const id = listReads === 1 ? "private:1" : "private:2";
        return Promise.resolve({ conversations: [privateConversation(id)] });
      }
      if (path === "/api/tools") return Promise.resolve({ tools: [] });
      if (/^\/api\/conversations\/private%3A[12]\/tools$/.test(path)) {
        return Promise.resolve({ conversationId: decodeURIComponent(path.split("/")[3] ?? ""), disabledTools: [] });
      }
      if (path === "/api/conversations/reply" && init?.method === "PUT") return firstSave.promise;
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings(conversationId);
    await state.load();
    state.setReplyEnabled(false);
    const saving = state.saveBehavior();

    conversationId.value = "private:2";
    await state.load();
    firstSave.reject(new Error("旧会话保存失败"));

    await expect(saving).resolves.toBe(false);
    expect(state.conversation.value?.id).toBe("private:2");
    expect(state.behaviorError.value).toBe("");
  });
});

function groupConversation() {
  return {
    id: "group:7",
    scope: "user_group" as const,
    title: "群聊",
    userId: 1,
    groupId: 7,
    replyEnabled: true,
    orchestratorEnabled: true,
    messageCount: 1,
    lastAt: "2026-07-10T00:00:00.000Z",
    lastText: "hello",
    messages: []
  };
}

function privateConversation(id: string) {
  return {
    id,
    scope: "private" as const,
    title: id,
    userId: Number(id.split(":")[1]),
    replyEnabled: true,
    messageCount: 1,
    lastAt: "2026-07-10T00:00:00.000Z",
    lastText: "hello",
    messages: []
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
