import type { Page, Route } from "@playwright/test";
import sharp from "sharp";
import type { AppConfig } from "../../src/types.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { parseFinalPromptTemplate } from "../../services/agent/promptSystem.js";
import { listToolMetadata } from "../../services/tools/toolRegistry.js";

const imageFixture = sharp({
  create: { width: 640, height: 640, channels: 4, background: "#d71921" }
}).png().toBuffer();

export const modelCatalog = [
  model("gpt-5.5", "5.5", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.6-sol", "5.6 Sol", "low", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-terra", "5.6 Terra", "medium", ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-luna", "5.6 Luna", "medium", ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.4", "5.4", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.4-mini", "5.4 Mini", "medium", ["low", "medium", "high", "xhigh"]),
  model("gpt-5.3-codex-spark", "5.3 Codex Spark", "high", ["low", "medium", "high", "xhigh"])
];

const initialConfig = {
  server: { host: "127.0.0.1", port: 8787 },
  persona: {
    defaultAgentId: "plana",
    agentWorkspace: "workspace/business/agents/plana",
    memoryLimit: 32
  },
  providers: {
    defaultProviderId: "codex",
    items: [
      {
        id: "codex",
        label: "Codex",
        kind: "codex-responses",
        enabled: true,
        model: "gpt-5.6-sol",
        imageModel: "gpt-image-2",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        apiKeyEnv: "CODEX_ACCESS_TOKEN",
        envFile: "workspace/secrets/runtime.env",
        temperature: 0.7,
        maxOutputTokens: 2400,
        reasoningEffort: "ultra",
        modelSource: "remote" as const,
        multimodal: "auto" as const
      }
    ]
  },
  bot: {
    adminQq: "171419991",
    adminName: "猫老师",
    quoteGroupReplies: true,
    contextMessageLimit: 48,
    memory: {
      memoryModel: "gpt-5.4-mini",
      reasoningEffort: "medium",
      messageThreshold: 48,
      workingMemoryMaxEntries: 100,
      workMemoryCompressInPrompt: "work_memory_compress_in.json",
      workMemoryCompressOutPrompt: "work_memory_compress_out.json",
      userProfilePrompt: "user_profile_prompt.json"
    },
    orchestrator: {
      enabled: true,
      userGroupchatOrchestratorModel: "gpt-5.6-luna",
      reasoningEffort: "max",
      promptFile: "user_groupchat_orchestrator.json",
      messageThreshold: 10,
      recentMessageWindowMs: 60_000
    },
    tools: {
      maxCalls: 20,
      overrides: {} as NonNullable<AppConfig["bot"]["tools"]["overrides"]>,
      websearch: {
        provider: "tavily",
        tavilyApiKey: "",
        tavilyApiKeys: [],
        tavilyApiKeyEnv: "TAVILY_API_KEY",
        maxResults: 5
      },
      codex: {
        enabled: true,
        model: "gpt-5.4-mini",
        codexExecutable: "auto",
        timeoutMs: 900_000,
        maxConcurrency: 2
      },
      generateImg: { provider: "codex-image-gen", size: "1024x1024", resolution: "1K", quality: "high" }
    },
    bash: {
      enabled: true,
      allowGroup: false,
      adminOnly: true,
      workspaceOnly: true,
      blockedKeywords: ["rm", "shutdown"]
    }
  },
  onebot: {
    reverseWsPath: "/onebot/v11/ws",
    accessTokenEnv: "ONEBOT_ACCESS_TOKEN",
    autoReplyPrivate: true,
    autoReplyUserGroup: true,
    autoReplyBotGroup: false,
    quoteGroupReplies: true,
    mentionNames: ["普拉娜", "Plana"],
    commandPrefixes: ["/suna", "普拉娜"]
  }
} satisfies AppConfig;

const initialAgentFiles = [
  file("persona.agents", "Agent 规则", "人格", "AGENTS.md", "保持专注，明确行动。\n"),
  file("persona.soul", "核心人格", "人格", "SOUL.md", "冷静、诚实、可靠。\n"),
  file("persona.preference", "偏好", "人格", "PREFERENCE.md", "使用简洁中文。\n"),
  file("persona.user", "用户关系", "人格", "USER.md", "称呼用户为猫老师。\n"),
  file("persona.relation", "关系", "人格", "RELATION.md", "长期协作伙伴。\n"),
  file("conversation.reply", "对话回复", "对话", "conversation_reply.json", defaultPromptContent("conversation.reply")),
  file("memory.compress-in", "工作记忆提取", "记忆", "work_memory_compress_in.json", defaultPromptContent("memory.compress-in")),
  file("memory.compress-out", "长期记忆压缩", "记忆", "work_memory_compress_out.json", defaultPromptContent("memory.compress-out")),
  file("memory.user-profile", "用户画像提取", "记忆", "user_profile_prompt.json", defaultPromptContent("memory.user-profile")),
  file("orchestrator.user-group", "群聊编排", "编排器", "user_groupchat_orchestrator.json", defaultPromptContent("orchestrator.user-group")),
  file("conversation.group-summary", "群聊总结", "对话", "group_chat_summary.json", defaultPromptContent("conversation.group-summary")),
  file("image.selfie-rewrite", "自拍提示词改写", "图像", "selfie_prompt_rewrite.json", defaultPromptContent("image.selfie-rewrite"))
];

interface MockTokenUsageBucket {
  input: number;
  cachedInput: number;
  cacheRate: number | null;
  output: number;
  total: number;
  requests: number;
}

interface MockTokenUsagePayload {
  today: MockTokenUsageBucket & { date: string };
  days: Array<MockTokenUsageBucket & { date: string }>;
  hours: Array<MockTokenUsageBucket & { hour: number }>;
}

interface MockWebChatMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  userId: number;
  senderName: string;
  text: string;
  at: string;
}

const initialWebChatMessages: MockWebChatMessage[] = [
  {
    id: "web-1",
    sequence: 1,
    role: "user",
    userId: 171419991,
    senderName: "猫老师",
    text: "检查今天的运行情况",
    at: "2026-07-10T02:00:00.000Z"
  },
  {
    id: "web-2",
    sequence: 2,
    role: "assistant",
    userId: 171419991,
    senderName: "普拉娜",
    text: "服务在线，今天已经处理 18 次模型请求。",
    at: "2026-07-10T02:00:03.000Z"
  }
];

const tokenUsageFixture: MockTokenUsagePayload = {
  today: {
    date: localDateOffset(0),
    input: 12_840,
    cachedInput: 7_200,
    cacheRate: 7_200 / 12_840,
    output: 3_260,
    total: 16_100,
    requests: 18
  },
  days: [
    tokenUsageDay(2, 9_000, 4_050, 2_100, 11_100, 12),
    tokenUsageDay(1, 11_200, 5_600, 2_800, 14_000, 15),
    tokenUsageDay(0, 12_840, 7_200, 3_260, 16_100, 18)
  ],
  hours: Array.from({ length: 24 }, (_, hour) => {
    const input = hour * 80;
    const cachedInput = hour * 40;
    return {
      hour,
      input,
      cachedInput,
      cacheRate: input > 0 ? cachedInput / input : 0,
      output: hour * 20,
      total: hour * 100,
      requests: hour % 3
    };
  })
};

export interface MockApiState {
  config: typeof initialConfig;
  revision: string;
  files: typeof initialAgentFiles;
  patchRequests: Array<{ section: string; body: unknown }>;
  fileWrites: Array<{ id: string; body: unknown }>;
  memoryWrites: Array<{ method: string; body: unknown }>;
  offline: boolean;
  requiredToken: string;
  authenticated: boolean;
  nextPatchError: string;
  imageHistoryError: string;
  qqOnline: boolean;
  qrVersion: number;
  tokenUsage: MockTokenUsagePayload;
  webChatMessages: MockWebChatMessage[];
  webChatRequests: string[];
  selfieReferences: Array<{
    id: string;
    fileName: string;
    sizeBytes: number;
    width: number;
    height: number;
    updatedAt: string;
    originalUrl: string;
    displayUrl: string;
    placeholderUrl: string;
  }>;
}

export async function installMockApi(page: Page, options: { requiredToken?: string } = {}): Promise<MockApiState> {
  const state: MockApiState = {
    config: structuredClone(initialConfig),
    revision: "config-r1",
    files: structuredClone(initialAgentFiles),
    patchRequests: [],
    fileWrites: [],
    memoryWrites: [],
    offline: false,
    requiredToken: options.requiredToken ?? "",
    authenticated: !options.requiredToken,
    nextPatchError: "",
    imageHistoryError: "",
    qqOnline: true,
    qrVersion: 1,
    tokenUsage: structuredClone(tokenUsageFixture),
    webChatMessages: structuredClone(initialWebChatMessages),
    webChatRequests: [],
    selfieReferences: [
      selfieReference("01-neutral-face.png", 458, 501, 241_664),
      selfieReference("02-gentle-smile.png", 458, 501, 244_736),
      selfieReference("03-full-outfit.jpg", 1200, 1393, 441_344)
    ]
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (pathname === "/api/auth/session") {
      return json(route, state.authenticated
        ? { authenticated: true, username: "admin", csrfToken: "mock-csrf", expiresAt: "2099-01-01T00:00:00.000Z" }
        : { authenticated: false });
    }

    if (pathname === "/api/auth/login" && method === "POST") {
      const body = request.postDataJSON() as { username?: string; password?: string };
      if (body.username === "admin" && body.password === state.requiredToken) {
        state.authenticated = true;
        return json(route, { authenticated: true, username: "admin", csrfToken: "mock-csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
      }
      return json(route, { error: { code: "ADMIN_UNAUTHORIZED", message: "管理员账号或密码无效。" } }, 401);
    }
    if (pathname === "/api/auth/logout" && method === "POST") {
      state.authenticated = false;
      return route.fulfill({ status: 204 });
    }

    if (state.requiredToken && !state.authenticated) {
      return json(route, {
        error: { code: "ADMIN_UNAUTHORIZED", message: "管理员会话无效或已过期。" }
      }, 401);
    }

    if (pathname === "/api/media/image" || pathname === "/api/media/qq-avatar" || pathname === "/api/media/thumbnail") {
      return route.fulfill({ status: 200, contentType: "image/png", body: await imageFixture });
    }

    if (/^\/api\/selfie-references\/[^/]+\/content$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: "image/png", body: await imageFixture });
    }
    if (pathname === "/api/selfie-references" && method === "GET") {
      return json(route, { images: state.selfieReferences, maxImages: 3 });
    }
    if (pathname === "/api/selfie-references" && method === "POST") {
      if (state.selfieReferences.length >= 3) {
        return json(route, { error: { code: "SELFIE_REFERENCE_LIMIT", message: "最多保留 3 张参考图。" } }, 409);
      }
      const body = request.postDataJSON() as { fileName?: string };
      state.selfieReferences.push(selfieReference(body.fileName || "reference.png", 640, 640, 16_384));
      return json(route, { images: state.selfieReferences, maxImages: 3 }, 201);
    }
    const selfieReferenceMatch = pathname.match(/^\/api\/selfie-references\/([^/]+)$/);
    if (selfieReferenceMatch && method === "DELETE") {
      const id = decodeURIComponent(selfieReferenceMatch[1]);
      state.selfieReferences = state.selfieReferences.filter((image) => image.id !== id);
      return route.fulfill({ status: 204 });
    }

    if (pathname === "/api/codex-auth/status") {
      return json(route, { installed: true, authenticated: false, login: { state: "idle" } });
    }

    if (pathname === "/api/token-usage") {
      return json(route, state.tokenUsage);
    }

    if (pathname === "/api/status") {
      return json(route, {
        startedAt: "2026-07-10T01:00:00.000Z",
        configPath: "/workspace/business/config/sunabot.json",
        onebot: {
          connected: !state.offline,
          connections: state.offline ? 0 : 1,
          selfIds: state.offline ? [] : ["123456"],
          connectedAt: "2026-07-10T01:05:00.000Z",
          lastEventAt: "2026-07-10T02:00:00.000Z"
        },
        persona: { id: "plana", name: "普拉娜", memoryItems: 128 },
        provider: {
          defaultProviderId: state.config.providers.defaultProviderId,
          model: state.config.providers.items[0].model,
          imageModel: "gpt-image-2",
          apiKeyConfigured: true
        },
        recovery: { required: false }
      });
    }

    if (pathname === "/api/config" && method === "GET") return json(route, configEnvelope(state));
    const sectionMatch = pathname.match(/^\/api\/config\/([^/]+)$/);
    if (sectionMatch && method === "PATCH") {
      const body = request.postDataJSON() as { revision?: string; value?: unknown };
      const section = decodeURIComponent(sectionMatch[1]);
      state.patchRequests.push({ section, body });
      if (state.nextPatchError) {
        const message = state.nextPatchError;
        state.nextPatchError = "";
        return json(route, { error: { code: "CONFIG_INVALID", message, field: `${section}.value` } }, 400);
      }
      if (body.revision !== state.revision) {
        return json(route, {
          error: { code: "CONFIG_REVISION_CONFLICT", message: "配置已更新。", latestRevision: state.revision }
        }, 409);
      }
      applySection(state.config, section, body.value);
      state.revision = `config-r${state.patchRequests.length + 1}`;
      return json(route, {
        ok: true,
        ...configEnvelope(state),
        applyMode: section === "server" ? "restart" : "hot",
        restartRequiredFields: section === "server" ? ["server.port"] : []
      });
    }

    if (pathname === "/api/models") {
      return json(route, {
        models: modelCatalog,
        reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        imageModels: [{ id: "gpt-image-2", label: "GPT Image 2" }]
      });
    }

    if (pathname === "/api/agent-files" && method === "GET") {
      return json(route, { files: state.files.map(({ content: _content, ...metadata }) => metadata) });
    }
    const fileMatch = pathname.match(/^\/api\/agent-files\/(.+)$/);
    if (fileMatch) {
      const id = decodeURIComponent(fileMatch[1]);
      const item = state.files.find((entry) => entry.id === id);
      if (!item) return json(route, { error: { code: "AGENT_FILE_NOT_FOUND", message: "文件不存在。" } }, 404);
      if (method === "GET") return json(route, item);
      if (method === "PUT") {
        const body = request.postDataJSON() as { content?: string; revision?: string };
        state.fileWrites.push({ id, body });
        if (body.revision !== item.revision) {
          return json(route, {
            error: { code: "AGENT_FILE_REVISION_CONFLICT", message: "文件已更新。", latestRevision: item.revision }
          }, 409);
        }
        item.content = body.content ?? "";
        item.empty = item.content.trim().length === 0;
        item.revision = `${id}-r${state.fileWrites.length + 1}`;
        item.updatedAt = "2026-07-10T02:30:00.000Z";
        return json(route, { ok: true, ...item });
      }
    }

    if (pathname === "/api/web-chat/messages") {
      if (method === "POST") {
        const body = request.postDataJSON() as { text?: string };
        const text = String(body.text ?? "").trim();
        state.webChatRequests.push(text);
        const nextSequence = state.webChatMessages.length + 1;
        state.webChatMessages.push(
          {
            id: `web-${nextSequence}`,
            sequence: nextSequence,
            role: "user",
            userId: 171419991,
            senderName: "猫老师",
            text,
            at: "2026-07-10T02:01:00.000Z"
          },
          {
            id: `web-${nextSequence + 1}`,
            sequence: nextSequence + 1,
            role: "assistant",
            userId: 171419991,
            senderName: "普拉娜",
            text: "收到，网页会话保持在线。",
            at: "2026-07-10T02:01:02.000Z"
          }
        );
      }
      return json(route, {
        conversationId: "web:admin",
        messages: state.webChatMessages,
        hasMore: false,
        memberNames: {}
      });
    }

    if (pathname === "/api/conversations") {
      return json(route, {
        conversations: [
          {
            id: "group:10001",
            scope: "user_group",
            title: "产品讨论群",
            userId: 20002,
            groupId: 10001,
            selfId: 123456,
            lastText: "正在输入…",
            lastAt: "2026-07-10T02:20:00.000Z",
            replyEnabled: true,
            orchestratorEnabled: true,
            orchestratorStatus: {
              active: true,
              messageCount: 3,
              messageTarget: 21,
              activeWindowMs: 60_000,
              lastMessageAt: "2026-07-10T02:00:00.000Z",
              lastCheckedAt: "2026-07-10T02:00:10.000Z"
            },
            messageCount: 24,
            messages: []
          },
          {
            id: "private:20002",
            scope: "private",
            title: "猫老师",
            userId: 20002,
            selfId: 123456,
            lastText: "继续执行。",
            lastAt: "2026-07-10T02:10:00.000Z",
            replyEnabled: true,
            messageCount: 9,
            messages: []
          }
        ]
      });
    }
    if (/^\/api\/conversations\/[^/]+\/messages$/.test(pathname)) {
      return json(route, {
        messages: [
          {
            id: "m-1",
            sequence: 1,
            role: "user",
            userId: 20002,
            groupId: 10001,
            senderName: "猫老师",
            senderNickname: "猫老师原昵称",
            senderCard: "猫老师",
            selfId: 123456,
            text: "模型列表加上 5.6。",
            at: "2026-07-10T02:00:00.000Z"
          },
          {
            id: "m-2",
            sequence: 2,
            role: "assistant",
            text: "编排器结果",
            at: "2026-07-10T02:00:10.000Z",
            senderName: "普拉娜",
            selfId: 123456,
            eventKind: "orchestrator_decision",
            visibility: "internal",
            logRunId: "orchestrator-failed-run",
            orchestratorDecision: {
              status: "failed",
              shouldReply: false,
              reason: "编排器判断失败，请查看请求日志。",
              raw: "provider unavailable"
            }
          },
          {
            id: "m-3",
            sequence: 3,
            role: "assistant",
            senderName: "普拉娜",
            senderNickname: "普拉娜 QQ",
            senderCard: "普拉娜",
            selfId: 123456,
            text: "模型目录已更新。",
            at: "2026-07-10T02:01:00.000Z"
          },
          {
            id: "m-4",
            sequence: 4,
            role: "assistant",
            senderName: "普拉娜",
            selfId: 123456,
            text: "正在输入…",
            at: "2026-07-10T02:02:00.000Z",
            requestStatus: "running",
            logRunId: "running-run"
          }
        ],
        conversationId: "group:10001",
        hasMore: false
      });
    }
    if (/^\/api\/conversations\/[^/]+\/logs$/.test(pathname)) {
      return json(route, {
        logs: url.searchParams.get("runId") === "running-run"
          ? [{
              id: "running-log",
              at: "2026-07-10T02:02:00.000Z",
              category: "runtime.action",
              action: "reply.started",
              response: { status: "running" },
              metadata: { runId: "running-run", conversationId: "group:10001" }
            }]
          : []
      });
    }
    if (pathname === "/api/conversations/reply") {
      const body = request.postDataJSON() as { id?: string; replyEnabled?: boolean; orchestratorEnabled?: boolean };
      const conversation = {
        id: body.id ?? "group:10001",
        scope: "user_group",
        title: "产品讨论群",
        userId: 20002,
        groupId: 10001,
        lastText: "模型目录已经更新。",
        lastAt: "2026-07-10T02:20:00.000Z",
        replyEnabled: body.replyEnabled ?? true,
        orchestratorEnabled: body.orchestratorEnabled ?? true,
        orchestratorStatus: {
          active: false,
          messageCount: 0,
          messageTarget: 21,
          activeWindowMs: 60_000,
          lastMessageAt: "2026-07-10T02:00:00.000Z",
          lastCheckedAt: "2026-07-10T02:00:10.000Z"
        },
        messageCount: 24,
        messages: []
      };
      return json(route, { ok: true, conversation });
    }

    if (pathname === "/api/images" && method === "GET") {
      if (state.imageHistoryError) return json(route, { error: { code: "IMAGE_HISTORY_FAILED", message: state.imageHistoryError } }, 500);
      return json(route, {
        images: [
          {
            id: "image-1",
            url: "/generated-images/image-1.png",
            prompt: "月球基地的清晨",
            size: "1024x1024",
            providerId: "codex",
            model: "gpt-image-2",
            createdAt: "2026-07-10T01:45:00.000Z"
          }
        ]
      });
    }
    if (pathname === "/api/playground/image" && method === "POST") {
      return json(route, { url: "/generated-images/new-image.png", model: "gpt-image-2", providerId: "codex" });
    }

    if (pathname === "/api/memory" && method === "GET") {
      return json(route, {
        sources: [
          { id: "working", title: "工作记忆", fileName: "sunabot.sqlite#memory/working", editable: true },
          { id: "long_term", title: "长期记忆", fileName: "sunabot.sqlite#memory/long-term", editable: true },
          { id: "user_profile", title: "用户画像", fileName: "sunabot.sqlite#memory/user-profile", editable: true }
        ],
        entries: [
          {
            id: "memory-1",
            source: "working",
            sourceTitle: "工作记忆",
            fileName: "sunabot.sqlite#memory/working",
            editable: true,
            key: "fact",
            value: "WebUI 使用 Vue 3、TypeScript 与 Tailwind。",
            text: "WebUI 使用 Vue 3、TypeScript 与 Tailwind。",
            field: "fact",
            occurredAt: "2026-07-10T01:00:00.000Z",
            occurredEndAt: "2026-07-10T01:05:00.000Z",
            createdAt: "2026-07-10T01:10:00.000Z",
            updatedAt: "2026-07-10T01:10:00.000Z"
          },
          {
            id: "long-term-1",
            source: "long_term",
            sourceTitle: "长期记忆",
            fileName: "sunabot.sqlite#memory/long-term",
            editable: true,
            key: "fact",
            value: "管理台完成了第一轮视觉检查。",
            text: "管理台完成了第一轮视觉检查。",
            field: "fact",
            legacyTime: "2026-07-09T08:00:00.000Z",
            updatedAt: "2026-07-09T08:30:00.000Z"
          },
          {
            id: "profile-1",
            source: "user_profile",
            sourceTitle: "用户画像",
            fileName: "sunabot.sqlite#memory/user-profile",
            editable: true,
            key: "QQ 20002",
            value: "偏好紧凑、清晰的管理界面。",
            text: "偏好紧凑、清晰的管理界面。",
            field: "fact",
            userId: "20002",
            userName: "最后观测昵称",
            addressName: "猫老师",
            userNickname: "猫老师原昵称",
            groupCards: [{ groupId: 10001, card: "猫老师", lastSeenAt: "2026-07-10T02:00:00.000Z" }],
            updatedAt: "2026-07-10T02:00:00.000Z"
          }
        ]
      });
    }
    if (pathname === "/api/memory/recall") {
      return json(route, { ok: true, query: "webui", matches: [] });
    }
    if (pathname === "/api/memory") {
      state.memoryWrites.push({ method, body: request.postDataJSON() });
      return json(route, { ok: true });
    }

    if (pathname === "/api/tools") {
      const conversationPrompt = state.files.find((file) => file.id === "conversation.reply");
      const prompt = conversationPrompt ? parseFinalPromptTemplate(conversationPrompt.content) : undefined;
      return json(route, {
        tools: listToolMetadata({
          onAssistantText: () => undefined,
          bash: {
            enabled: state.config.bot.bash.enabled,
            workspaceOnly: state.config.bot.bash.workspaceOnly,
            blockedKeywords: state.config.bot.bash.blockedKeywords
          },
          bot: state.config.bot,
          selfie: { enabled: true },
          memory: { enabled: true },
          asyncCodex: state.config.bot.tools.codex.enabled,
          asyncImage: true
        }, prompt?.tools)
      });
    }
    if (pathname === "/api/request-logs") {
      const logs = [
        {
          id: "log-56",
          at: "2026-07-10T02:12:00.000Z",
          category: "model.response",
          action: "codex.tool.complete",
          providerId: "codex-cli",
          model: "gpt-5.6-sol",
          tokenUsage: { input: 100, cachedInput: 80, cacheRate: 0.8, output: 10, total: 110 },
          response: { ok: true, status: "succeeded", usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } }
        },
        {
          id: "log-55",
          at: "2026-07-10T02:11:00.000Z",
          category: "model.response",
          action: "responses.complete",
          providerId: "codex",
          model: "gpt-5.6-sol",
          tokenUsage: { input: 820, cachedInput: 640, cacheRate: 640 / 820, output: 160, total: 980 },
          response: { ok: true, summary: { usage: { input_tokens: 820, input_tokens_details: { cached_tokens: 640 }, output_tokens: 160, total_tokens: 980 } } }
        },
        {
          id: "log-54",
          at: "2026-07-10T02:10:00.000Z",
          category: "model.response",
          action: "chat.completions.complete",
          providerId: "openai-compatible",
          model: "compatible-model",
          tokenUsage: { input: 240, cachedInput: 120, cacheRate: 0.5, output: 60, total: 300 },
          response: { ok: true, usage: { prompt_tokens: 240, prompt_tokens_details: { cached_tokens: 120 }, completion_tokens: 60, total_tokens: 300 } }
        },
        {
          id: "log-53",
          at: "2026-07-10T02:09:00.000Z",
          category: "model.response",
          action: "anthropic.messages.complete",
          providerId: "anthropic",
          model: "claude-sonnet",
          tokenUsage: { input: 230, cachedInput: 120, cacheRate: 120 / 230, output: 40, total: 270 },
          response: { ok: true, usage: { input_tokens: 30, cache_creation_input_tokens: 80, cache_read_input_tokens: 120, output_tokens: 40 } }
        },
        {
          id: "log-52",
          at: "2026-07-10T02:08:00.000Z",
          category: "model.response",
          action: "gemini.generate-content.complete",
          providerId: "gemini",
          model: "gemini-2.5-flash",
          tokenUsage: { input: 200, cachedInput: 90, cacheRate: 0.45, output: 50, total: 250 },
          response: { ok: true, usage: { promptTokenCount: 200, cachedContentTokenCount: 90, candidatesTokenCount: 35, thoughtsTokenCount: 15, totalTokenCount: 250 } }
        },
        { id: "log-51", at: "2026-07-10T02:07:00.000Z", category: "model.request", action: "responses.complete", providerId: "codex", model: "gpt-5.6-sol", request: { model: "gpt-5.6-sol", input: [{ role: "user", content: "你好" }] } },
        ...Array.from({ length: 50 }, (_, index) => ({
          id: `log-${50 - index}`,
          at: new Date(Date.UTC(2026, 6, 10, 2, 6, 59 - index)).toISOString(),
          category: "runtime.action",
          action: index % 2 ? "reply.sent" : "reply.started",
          metadata: { sequence: 50 - index }
        }))
      ];
      const pageNumber = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const pageSize = Math.max(1, Number(url.searchParams.get("pageSize") ?? url.searchParams.get("limit") ?? 50));
      const start = (pageNumber - 1) * pageSize;
      return json(route, {
        filePath: "/data/sunabot.sqlite",
        page: pageNumber,
        pageSize,
        total: logs.length,
        pageCount: Math.ceil(logs.length / pageSize),
        logs: logs.slice(start, start + pageSize)
      });
    }
    if (pathname === "/api/providers/test") {
      return json(route, { ok: true, model: "gpt-5.6-sol", elapsedMs: 128 });
    }
    if (pathname === "/api/providers/models") {
      return json(route, { ok: true, models: modelCatalog.map((model) => model.id) });
    }
    if (pathname === "/api/providers/vision-probe") {
      return json(route, { ok: true, multimodal: true });
    }
    if (pathname === "/api/onebot/login-info") {
      return json(route, state.qqOnline
        ? { connected: true, data: { user_id: 123456, nickname: "普拉娜" } }
        : { connected: false, error: "OneBot 未连接。" });
    }
    if (pathname === "/api/onebot/events") return json(route, { events: [{ receivedAt: "2026-07-10T02:06:00.000Z", postType: "message", messageType: "private", text: "收到管理员消息" }] });
    if (pathname === "/api/onebot/chats") return json(route, { connected: true, private: [], groups: [] });
    if (pathname === "/api/onebot/qq-logout" && method === "POST") {
      state.qqOnline = false;
      state.offline = true;
      state.qrVersion += 1;
      return json(route, { connected: false, online: false, available: true, phase: "restarting" });
    }
    if (pathname === "/api/onebot/qq-login" || pathname === "/api/onebot/qq-login/status") {
      if (state.qqOnline) {
        return json(route, { connected: true, online: true, available: true, phase: "online", data: { user_id: 123456, nickname: "普拉娜" } });
      }
      if (method === "POST") state.qrVersion += 1;
      const qr = (await imageFixture).toString("base64");
      return json(route, {
        connected: false,
        online: false,
        available: true,
        phase: "waiting_scan",
        imageDataUrl: `data:image/png;base64,${qr}`,
        imageUpdatedAt: new Date(Date.UTC(2026, 6, 12, 0, 0, state.qrVersion)).toISOString()
      });
    }
    if (pathname === "/api/onebot/napcat-webui-url") {
      return json(route, { url: "http://127.0.0.1:6099" });
    }

    return json(route, { error: { code: "MOCK_ROUTE_MISSING", message: `${method} ${pathname}` } }, 404);
  });

  await page.route("**/generated-images/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: await imageFixture
    });
  });

  return state;
}

function configEnvelope(state: MockApiState) {
  const config = structuredClone(state.config);
  config.bot.tools.websearch.tavilyApiKey = "";
  config.bot.tools.websearch.tavilyApiKeys = [];
  const storedTavilyKeys = [...new Set([
    ...state.config.bot.tools.websearch.tavilyApiKeys,
    state.config.bot.tools.websearch.tavilyApiKey
  ].filter(Boolean))];
  const tavilyConfigured = storedTavilyKeys.length > 0;
  const tavilyFieldState = {
    applyMode: "hot" as const,
    secretConfigured: tavilyConfigured,
    secretCount: storedTavilyKeys.length,
    storedSecretCount: storedTavilyKeys.length
  };
  return {
    config,
    revision: state.revision,
    fieldStates: {
      "server.host": { applyMode: "restart" },
      "server.port": { applyMode: "restart" },
      "onebot.accessTokenEnv": { applyMode: "reconnect", secretConfigured: true },
      "providers.items.codex.apiKeyEnv": { applyMode: "hot", secretConfigured: true },
      "bot.tools.websearch.tavilyApiKey": tavilyFieldState,
      "bot.tools.websearch.tavilyApiKeys": tavilyFieldState,
      "bot.tools.websearch.tavilyApiKeyEnv": tavilyFieldState
    }
  };
}

function applySection(config: typeof initialConfig, section: string, value: unknown) {
  const next = structuredClone(value) as Record<string, unknown>;
  if (section === "server" || section === "providers") {
    Object.assign(config[section], next);
    return;
  }
  if (section === "persona") {
    Object.assign(config.persona, next);
    return;
  }
  if (section === "bot") {
    Object.assign(config.bot, next);
    config.onebot.quoteGroupReplies = config.bot.quoteGroupReplies;
    return;
  }
  if (section === "tools") {
    const incoming = next as typeof config.bot.tools & {
      websearch: typeof config.bot.tools.websearch & {
        clearTavilyApiKey?: boolean;
        removeTavilyApiKeyIndexes?: number[];
      };
    };
    const currentKeys = [...new Set([
      ...config.bot.tools.websearch.tavilyApiKeys,
      config.bot.tools.websearch.tavilyApiKey
    ].filter(Boolean))];
    const removals = new Set(incoming.websearch.removeTavilyApiKeyIndexes ?? []);
    const retainedKeys = incoming.websearch.clearTavilyApiKey
      ? []
      : currentKeys.filter((_, index) => !removals.has(index));
    const nextKeys = [...new Set([
      ...retainedKeys,
      ...incoming.websearch.tavilyApiKeys.filter(Boolean),
      incoming.websearch.tavilyApiKey
    ].filter(Boolean))];
    delete incoming.websearch.clearTavilyApiKey;
    delete incoming.websearch.removeTavilyApiKeyIndexes;
    Object.assign(config.bot.tools, incoming);
    config.bot.tools.websearch.tavilyApiKey = "";
    config.bot.tools.websearch.tavilyApiKeys = nextKeys;
    return;
  }
  if (section === "memory" || section === "orchestrator" || section === "bash") {
    Object.assign(config.bot[section], next);
    return;
  }
  if (section === "onebot") Object.assign(config.onebot, next);
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function selfieReference(fileName: string, width: number, height: number, sizeBytes: number) {
  const id = fileName;
  const path = `/api/selfie-references/${encodeURIComponent(id)}/content`;
  return {
    id,
    fileName,
    sizeBytes,
    width,
    height,
    updatedAt: "2026-07-12T10:00:00.000Z",
    originalUrl: `${path}?variant=original`,
    displayUrl: `${path}?variant=display`,
    placeholderUrl: `${path}?variant=placeholder`
  };
}

function tokenUsageDay(
  daysAgo: number,
  input: number,
  cachedInput: number,
  output: number,
  total: number,
  requests: number
): MockTokenUsageBucket & { date: string } {
  return {
    date: localDateOffset(daysAgo),
    input,
    cachedInput,
    cacheRate: input > 0 ? cachedInput / input : 0,
    output,
    total,
    requests
  };
}

function localDateOffset(daysAgo: number) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function model(id: string, label: string, defaultReasoningEffort: string, reasoningEfforts: string[]) {
  return { id, label, defaultReasoningEffort, reasoningEfforts };
}

function file(id: string, title: string, category: string, fileName: string, content: string) {
  const definition = promptDefinitionById(id);
  return {
    id,
    title,
    category,
    kind: definition?.kind ?? "fragment",
    variables: definition?.variables ?? [],
    fileName,
    content,
    updatedAt: "2026-07-10T01:00:00.000Z",
    revision: `${id}-r1`,
    empty: content.trim().length === 0
  };
}
