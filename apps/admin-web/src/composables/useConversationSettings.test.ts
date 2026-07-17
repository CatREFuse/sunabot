// @vitest-environment happy-dom
import { ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAgentId } from "./agentScope";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("./useAdminApi", () => ({ apiRequest }));

import { useConversationSettings } from "./useConversationSettings";

describe("useConversationSettings", () => {
  beforeEach(() => {
    apiRequest.mockReset();
    setActiveAgentId("plana");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("serializes reply and tool auto-sync for one QQ conversation", async () => {
    const replyWrite = deferred<{ conversation: ReturnType<typeof groupConversation> }>();
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (pathname(path) === "/api/conversations") return Promise.resolve({ conversations: [groupConversation()] });
      if (pathname(path) === "/api/tools") return Promise.resolve({ tools: [
        { name: "read_file", title: "读取文件", description: "读取文件", enabled: true },
        { name: "codex", title: "Codex", description: "执行任务", enabled: true }
      ] });
      if (pathname(path) === "/api/conversations/group%3A7/tools" && init?.method === "PUT") {
        return Promise.resolve({ conversationId: "group:7", disabledTools: ["codex"] });
      }
      if (pathname(path) === "/api/conversations/group%3A7/tools") {
        return Promise.resolve({ conversationId: "group:7", disabledTools: ["read_file"] });
      }
      if (pathname(path) === "/api/conversations/reply" && init?.method === "PUT") return replyWrite.promise;
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings("group:7");

    await expect(state.load()).resolves.toBe(true);
    state.setReplyEnabled(false);
    state.setReplyEnabled(true);
    state.setReplyEnabled(false);
    state.setOrchestratorEnabled(false);
    state.setToolEnabled("read_file", true);
    state.setToolEnabled("codex", false);
    const flushing = state.flush();

    await vi.waitFor(() => expect(putPaths()).toEqual(["/api/conversations/reply"]));
    replyWrite.resolve({ conversation: { ...groupConversation(), replyEnabled: false, orchestratorEnabled: false } });
    await expect(flushing).resolves.toBe(true);

    expect(putPaths()).toEqual([
      "/api/conversations/reply",
      "/api/conversations/group%3A7/tools"
    ]);
    expect(JSON.parse(apiRequest.mock.calls.find(([path]) => pathname(path) === "/api/conversations/reply")?.[1]?.body)).toMatchObject({
      id: "group:7",
      replyEnabled: false,
      orchestratorEnabled: false
    });
    expect(state.behaviorDirty.value).toBe(false);
    expect(state.toolsDirty.value).toBe(false);
    expect(state.behaviorState.value).toEqual({ kind: "saved", message: "已同步" });
    expect(state.toolState.value).toEqual({ kind: "saved", message: "已同步" });
  });

  it("debounces an ordinary change before syncing it automatically", async () => {
    vi.useFakeTimers();
    mockLoadedConversation();
    const state = useConversationSettings("group:7");
    await state.load();

    state.setReplyEnabled(false);
    state.setReplyEnabled(true);
    state.setReplyEnabled(false);
    expect(state.behaviorState.value).toEqual({ kind: "waiting", message: "等待同步" });
    await vi.advanceTimersByTimeAsync(349);
    expect(putPaths()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(putPaths()).toEqual(["/api/conversations/reply"]);
    const submitted = JSON.parse(apiRequest.mock.calls.find(([path]) => pathname(path) === "/api/conversations/reply")?.[1]?.body);
    expect(submitted.replyEnabled).toBe(false);
    expect(state.replyEnabled.value).toBe(false);
    expect(state.behaviorDirty.value).toBe(false);
  });

  it("keeps an edit made during sync and submits it after the first response", async () => {
    const firstWrite = deferred<{ conversation: ReturnType<typeof groupConversation> }>();
    let replyWrites = 0;
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (pathname(path) === "/api/conversations") return Promise.resolve({ conversations: [groupConversation()] });
      if (pathname(path) === "/api/tools") return Promise.resolve({ tools: [] });
      if (pathname(path) === "/api/conversations/group%3A7/tools") {
        return Promise.resolve({ conversationId: "group:7", disabledTools: [] });
      }
      if (pathname(path) === "/api/conversations/reply" && init?.method === "PUT") {
        replyWrites += 1;
        if (replyWrites === 1) return firstWrite.promise;
        const body = JSON.parse(String(init.body)) as { replyEnabled: boolean; orchestratorEnabled: boolean };
        return Promise.resolve({ conversation: { ...groupConversation(), ...body } });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings("group:7");
    await state.load();

    state.setReplyEnabled(false);
    const flushing = state.flush();
    await vi.waitFor(() => expect(state.behaviorSyncing.value).toBe(true));
    state.setReplyEnabled(true);
    firstWrite.resolve({ conversation: { ...groupConversation(), replyEnabled: false } });

    await expect(flushing).resolves.toBe(true);
    const submittedValues = apiRequest.mock.calls
      .filter(([path, init]) => pathname(path) === "/api/conversations/reply" && init?.method === "PUT")
      .map(([, init]) => JSON.parse(String(init?.body)).replyEnabled);
    expect(submittedValues).toEqual([false, true]);
    expect(state.replyEnabled.value).toBe(true);
    expect(state.behaviorDirty.value).toBe(false);
  });

  it("keeps the latest reply input and reports a failed route flush", async () => {
    mockLoadedConversation({ replyError: "回复设置同步失败" });
    const state = useConversationSettings("group:7");
    await state.load();

    state.setReplyEnabled(false);

    await expect(state.flush()).resolves.toBe(false);
    expect(state.replyEnabled.value).toBe(false);
    expect(state.behaviorDirty.value).toBe(true);
    expect(state.behaviorState.value).toEqual({ kind: "error", message: "回复设置同步失败" });
  });

  it("keeps the latest tool selection after a failed sync", async () => {
    mockLoadedConversation({ toolError: "工具权限同步失败" });
    const state = useConversationSettings("group:7");
    await state.load();

    state.setToolEnabled("read_file", false);

    await expect(state.flush()).resolves.toBe(false);
    expect(state.disabledTools.value).toEqual(["read_file"]);
    expect(state.toolsDirty.value).toBe(true);
    expect(state.toolState.value).toEqual({ kind: "error", message: "工具权限同步失败" });
  });

  it("gives Web Chat the same isolated tool page without QQ reply settings", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (pathname(path) === "/api/tools") return Promise.resolve({
        tools: [{ name: "read_file", title: "读取文件", description: "读取文件", enabled: true }]
      });
      if (pathname(path) === "/api/conversations/web%3Aadmin/tools") {
        return Promise.resolve({ conversationId: "web:admin", disabledTools: [] });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings("web:admin");

    await expect(state.load()).resolves.toBe(true);

    expect(state.conversation.value).toMatchObject({ id: "web:admin", title: "Web Chat" });
    expect(state.supportsBehavior.value).toBe(false);
    expect(apiRequest.mock.calls.some(([path]) => pathname(path) === "/api/conversations")).toBe(false);
  });

  it("keeps QQ reply settings available when the tool catalog cannot load", async () => {
    apiRequest.mockImplementation((path: string) => {
      if (pathname(path) === "/api/conversations") return Promise.resolve({ conversations: [groupConversation()] });
      if (pathname(path) === "/api/tools") return Promise.reject(new Error("工具目录不可用"));
      if (pathname(path) === "/api/conversations/group%3A7/tools") {
        return Promise.resolve({ conversationId: "group:7", disabledTools: [] });
      }
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings("group:7");

    await expect(state.load()).resolves.toBe(false);

    expect(state.conversation.value?.id).toBe("group:7");
    expect(state.supportsBehavior.value).toBe(true);
    expect(state.loadError.value).toBe("");
    expect(state.toolState.value).toEqual({ kind: "error", message: "工具目录不可用" });
  });

  it("cancels the old queue and ignores its late response when the conversation changes", async () => {
    const conversationId = ref("private:1");
    const firstWrite = deferred<{ conversation: ReturnType<typeof privateConversation> }>();
    apiRequest.mockImplementation((path: string, init?: RequestInit) => {
      if (pathname(path) === "/api/conversations") {
        const id = path.includes("agentId=arona") ? "private:2" : conversationId.value;
        return Promise.resolve({ conversations: [privateConversation(id)] });
      }
      if (pathname(path) === "/api/tools") return Promise.resolve({ tools: [] });
      if (/^\/api\/conversations\/private%3A[12]\/tools$/.test(pathname(path))) {
        return Promise.resolve({ conversationId: decodeURIComponent(pathname(path).split("/")[3] ?? ""), disabledTools: [] });
      }
      if (pathname(path) === "/api/conversations/reply" && init?.method === "PUT") return firstWrite.promise;
      throw new Error(`unexpected request: ${path}`);
    });
    const state = useConversationSettings(conversationId);
    await state.load();
    state.setReplyEnabled(false);
    const firstFlush = state.flush();
    await vi.waitFor(() => expect(putPaths()).toHaveLength(1));

    conversationId.value = "private:2";
    await expect(state.load()).resolves.toBe(true);
    firstWrite.resolve({ conversation: { ...privateConversation("private:1"), replyEnabled: false } });

    await expect(firstFlush).resolves.toBe(false);
    expect(state.conversation.value?.id).toBe("private:2");
    expect(state.replyEnabled.value).toBe(true);
    expect(state.behaviorState.value).toEqual({ kind: "idle", message: "" });
  });

  it("cancels pending writes when the active Agent changes", async () => {
    mockLoadedConversation();
    const state = useConversationSettings("group:7");
    await state.load();
    state.setReplyEnabled(false);
    state.setToolEnabled("read_file", false);

    setActiveAgentId("arona");
    await state.load();

    expect(putPaths()).toEqual([]);
    expect(apiRequest.mock.calls.some(([path]) => path.includes("agentId=arona"))).toBe(true);
    expect(state.behaviorDirty.value).toBe(false);
    expect(state.toolsDirty.value).toBe(false);
  });

  it("reports a missing QQ conversation without creating settings for it", async () => {
    apiRequest.mockResolvedValue({ conversations: [] });
    const state = useConversationSettings("private:999");

    await expect(state.load()).resolves.toBe(false);

    expect(state.conversation.value).toBeNull();
    expect(state.loadError.value).toBe("会话不存在");
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });
});

function mockLoadedConversation(options: { replyError?: string; toolError?: string } = {}) {
  apiRequest.mockImplementation((path: string, init?: RequestInit) => {
    if (pathname(path) === "/api/conversations") return Promise.resolve({ conversations: [groupConversation()] });
    if (pathname(path) === "/api/tools") return Promise.resolve({
      tools: [{ name: "read_file", title: "读取文件", description: "读取文件", enabled: true }]
    });
    if (pathname(path) === "/api/conversations/group%3A7/tools" && init?.method === "PUT") {
      if (options.toolError) return Promise.reject(new Error(options.toolError));
      return Promise.resolve({ conversationId: "group:7", disabledTools: JSON.parse(String(init.body)).disabledTools });
    }
    if (pathname(path) === "/api/conversations/group%3A7/tools") {
      return Promise.resolve({ conversationId: "group:7", disabledTools: [] });
    }
    if (pathname(path) === "/api/conversations/reply" && init?.method === "PUT") {
      if (options.replyError) return Promise.reject(new Error(options.replyError));
      const body = JSON.parse(String(init.body)) as { replyEnabled: boolean; orchestratorEnabled?: boolean };
      return Promise.resolve({ conversation: { ...groupConversation(), ...body } });
    }
    throw new Error(`unexpected request: ${path}`);
  });
}

function putPaths() {
  return apiRequest.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([path]) => pathname(path));
}

function pathname(path: string) {
  return path.split("?", 1)[0] ?? path;
}

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
