import type { Page, Route } from "@playwright/test";
import sharp from "sharp";
import type { AppConfig } from "../../src/types.js";
import type { AgentAccount, AgentSummary } from "../../apps/admin-web/src/types.js";
import type { VoiceProfile, VoiceProviderStatus } from "../../apps/admin-web/src/types/voice.js";
import type {
  AgentMcpServer,
  AgentSkillRecord,
  McpApprovalTicket,
  SkillCopyPreview
} from "../../apps/admin-web/src/types/agentExtensions.js";
import {
  mcpHttpCredentialEnvironmentKey,
  mcpStdioCredentialEnvironmentKey
} from "../../packages/contracts/extensions/agentExtensions.js";
import { promptDefinitionById } from "../../services/agent/promptCatalog.js";
import { defaultPromptContent } from "../../services/agent/promptDefaults.js";
import { parseFinalPromptTemplate } from "../../services/agent/promptSystem.js";
import { BUILTIN_SKILL_TOOL_CAPABILITIES } from "../../services/tools/skillRuntimeTool.js";
import { listToolMetadata } from "../../services/tools/toolRegistry.js";

const imageFixture = sharp({
  create: { width: 640, height: 640, channels: 4, background: "#d71921" }
}).png().toBuffer();
const skillCopyPreviewRevision = "f".repeat(64);
const skillCopyRevisions = {
  sourceSkill: "1".repeat(64),
  targetSkill: "2".repeat(64),
  sourceMcp: "3".repeat(64),
  targetMcp: "4".repeat(64)
};

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
  schemaVersion: 1,
  server: { host: "127.0.0.1", port: 8787 },
  persona: {
    defaultAgentId: "plana",
    name: "普拉娜",
    agentWorkspace: "workspace/business/agents/plana",
    systemPromptWorkspace: "workspace/business/prompts",
    systemPromptOverride: false
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
  broadcastStorm: {
    enabled: true,
    windowMinutes: 2,
    replyThreshold: 3,
    cooldownMinutes: 1,
    additionalQqIds: []
  },
  normalReply: {
    maxRetries: 3
  },
  bot: {
    adminQq: "171419991",
    adminName: "猫老师",
    replyDebounceMs: 5_000,
    pokeOnNoReply: false,
    quoteGroupReplies: true,
    quoteGroupReplyExcludedUserIds: [],
    contextMessageLimit: 48,
    tone: {
      enabled: false,
      providerId: "",
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
      temperature: 0.7,
      maxOutputTokens: 2400,
      maxRetries: 2
    },
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
      groupThreadModel: "gpt-5.4-mini",
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
      adminPrivateBackend: "native",
      auditModel: "gpt-5.4-mini",
      strictMode: true,
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
  file(
    "persona.dialogue_style_examples",
    "对话风格示例",
    "人格",
    "DIALOGUE_STYLE_EXAMPLES.md",
    "用户：处理完成了吗？\nAgent：已完成。\n"
  ),
  file("persona.user", "用户关系", "人格", "USER.md", "称呼用户为猫老师。\n"),
  file("persona.relation", "关系", "人格", "RELATION.md", "长期协作伙伴。\n"),
  file(
    "conversation.private-reply",
    "单聊回复",
    "对话",
    "conversation_private_reply.json",
    defaultPromptContent("conversation.private-reply")
  ),
  file(
    "conversation.group-reply",
    "群聊回复",
    "对话",
    "conversation_group_reply.json",
    defaultPromptContent("conversation.group-reply")
  ),
  file(
    "conversation.tone-rewrite",
    "语气改写",
    "对话",
    "tone_rewrite.json",
    defaultPromptContent("conversation.tone-rewrite")
  ),
  file("memory.compress-in", "工作记忆提取", "记忆", "work_memory_compress_in.json", defaultPromptContent("memory.compress-in")),
  file("memory.compress-out", "长期记忆压缩", "记忆", "work_memory_compress_out.json", defaultPromptContent("memory.compress-out")),
  file("memory.user-profile", "用户画像提取", "记忆", "user_profile_prompt.json", defaultPromptContent("memory.user-profile")),
  file("orchestrator.user-group", "群聊编排", "编排器", "user_groupchat_orchestrator.json", defaultPromptContent("orchestrator.user-group")),
  file("conversation.group-summary", "群聊总结", "对话", "group_chat_summary.json", defaultPromptContent("conversation.group-summary")),
  file("scheduler.cron-callback", "定时任务回调", "调度", "cron_callback.json", defaultPromptContent("scheduler.cron-callback")),
  file("image.selfie-rewrite", "自拍提示词改写", "图像", "selfie_prompt_rewrite.json", defaultPromptContent("image.selfie-rewrite"))
];

type MockAgent = Omit<AgentSummary, "accounts"> & { accounts: AgentAccount[] };

const initialAgents: MockAgent[] = [
  {
    id: "plana",
    name: "普拉娜",
    enabled: true,
    workspace: "workspace/business/agents/plana",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    runtime: { loaded: true, persona: { id: "plana", name: "普拉娜", memoryItems: 128 } },
    accounts: [{
      id: "primary",
      agentId: "plana",
      label: "主账号",
      qqId: "123456",
      enabled: true,
      webuiPort: 6099,
      connected: true,
      runtimeReady: true,
      selfId: "123456",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }]
  },
  {
    id: "arona",
    name: "阿罗娜",
    enabled: true,
    workspace: "workspace/business/agents/arona",
    avatarPath: "assets/avatar.png",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    runtime: { loaded: true, persona: { id: "arona", name: "阿罗娜", memoryItems: 36 } },
    accounts: [{
      id: "qq_arona_main",
      agentId: "arona",
      label: "阿罗娜主账号",
      enabled: true,
      webuiPort: 6100,
      connected: false,
      runtimeReady: true,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z"
    }]
  }
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
  filters: { models: string[]; model: string; behavior: string };
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
  }),
  filters: { models: ["gpt-5.4-mini", "gpt-5.6-terra", "__unlabeled__"], model: "", behavior: "" }
};

const initialVoiceProfiles: Record<string, VoiceProfile> = Object.fromEntries(
  ["plana", "arona", "koharu"].map((agentId) => [agentId, {
    schemaVersion: 1,
    enabled: true,
    defaultLanguage: "ja",
    languages: {
      zh: null,
      en: null,
      ja: {
        language: "ja",
        fileName: `kivo-${agentId}-ja.wav`,
        relativePath: `voice/references/kivo-${agentId}-ja-${"a".repeat(64)}.wav`,
        mimeType: "audio/wav",
        sizeBytes: 1_299_818,
        sha256: "a".repeat(64),
        referenceText: agentId === "plana"
          ? "待機中、解決しなければならない作業が多数存在しています。"
          : "先生、おかえりなさい。今日もよろしくお願いします。",
        sourceUrl: "https://static.kivo.wiki/voices/mock/reference.ogg",
        characterUrl: "https://kivo.wiki/",
        updatedAt: "2026-07-19T01:00:00.000Z"
      }
    }
  } satisfies VoiceProfile])
);

const readyVoiceProvider: VoiceProviderStatus = {
  provider: "MOSS-TTS-Nano",
  ready: true,
  checkedAt: "2026-07-19T01:00:00.000Z",
  latencyMs: 18,
  serviceState: "running",
  controlsAvailable: true
};

function filteredTokenUsage(payload: MockTokenUsagePayload, model: string, behavior: string): MockTokenUsagePayload {
  const factor = (model ? 0.5 : 1) * (behavior ? 0.5 : 1);
  const scale = <T extends MockTokenUsageBucket>(bucket: T): T => ({
    ...bucket,
    input: Math.round(bucket.input * factor),
    cachedInput: Math.round(bucket.cachedInput * factor),
    output: Math.round(bucket.output * factor),
    total: Math.round(bucket.total * factor),
    requests: Math.round(bucket.requests * factor)
  });
  return {
    today: scale(payload.today),
    days: payload.days.map(scale),
    hours: payload.hours.map(scale),
    filters: { ...payload.filters, model, behavior }
  };
}

export interface MockApiState {
  config: typeof initialConfig;
  revision: string;
  doctorRevision: string;
  doctorHealthy: boolean;
  doctorProposalSource: "rules" | "ai";
  doctorRequests: Array<{ method: string; path: string; body?: unknown }>;
  files: typeof initialAgentFiles;
  agents: MockAgent[];
  avatarUpdates: Array<{ agentId: string; fileName: string; dataBase64: string }>;
  promptOverrides: Record<string, boolean>;
  patchRequests: Array<{ section: string; body: unknown }>;
  fileWrites: Array<{ id: string; body: unknown }>;
  memoryWrites: Array<{ method: string; body: unknown }>;
  offline: boolean;
  requiredToken: string;
  authenticated: boolean;
  adminPassword: string;
  passwordChanges: Array<{ currentPassword: string; newPassword: string; confirmPassword: string }>;
  nextPatchError: string;
  nextMonitoringError: string;
  monitoringSettings: {
    barkConfigured: boolean;
    aggregationWindowSeconds: number;
    onebotOfflineGraceSeconds: number;
    heartbeatStaleSeconds: number;
    serverEventsEnabled: boolean;
    onebotEventsEnabled: boolean;
  };
  monitoringWrites: Array<Record<string, unknown>>;
  nextConversationError: string;
  nextConversationToolError: string;
  imageHistoryError: string;
  qqOnline: boolean;
  qrVersion: number;
  tokenUsage: MockTokenUsagePayload;
  tokenUsageRequests: string[];
  webChatMessages: MockWebChatMessage[];
  webChatRequests: string[];
  conversationTools: Record<string, string[]>;
  conversationToolRequests: Array<{ conversationId: string; disabledTools: string[] }>;
  conversationReplySettings: Record<string, { replyEnabled: boolean; orchestratorEnabled?: boolean }>;
  conversationReplyRequests: Array<{ conversationId: string; replyEnabled: boolean; orchestratorEnabled?: boolean }>;
  extensions: Record<string, { skills: AgentSkillRecord[]; servers: AgentMcpServer[] }>;
  extensionRequests: Array<{ method: string; path: string; body?: unknown }>;
  mcpApprovals: McpApprovalTicket[];
  selfieReferences: Array<{
    id: string;
    fileName: string;
    note: string;
    sizeBytes: number;
    width: number;
    height: number;
    updatedAt: string;
    originalUrl: string;
    displayUrl: string;
    placeholderUrl: string;
  }>;
  voiceProfiles: Record<string, VoiceProfile>;
  voiceProvider: VoiceProviderStatus;
  voiceServiceRequests: string[];
}

export async function installMockApi(page: Page, options: { requiredToken?: string } = {}): Promise<MockApiState> {
  const state: MockApiState = {
    config: structuredClone(initialConfig),
    revision: "config-r1",
    doctorRevision: "doctor-r1",
    doctorHealthy: false,
    doctorProposalSource: "rules",
    doctorRequests: [],
    files: structuredClone(initialAgentFiles),
    agents: structuredClone(initialAgents),
    avatarUpdates: [],
    promptOverrides: { plana: false, arona: false },
    patchRequests: [],
    fileWrites: [],
    memoryWrites: [],
    offline: false,
    requiredToken: options.requiredToken ?? "",
    authenticated: !options.requiredToken,
    adminPassword: options.requiredToken || "session-secret",
    passwordChanges: [],
    nextPatchError: "",
    nextMonitoringError: "",
    monitoringSettings: {
      barkConfigured: false,
      aggregationWindowSeconds: 60,
      onebotOfflineGraceSeconds: 20,
      heartbeatStaleSeconds: 120,
      serverEventsEnabled: true,
      onebotEventsEnabled: true
    },
    monitoringWrites: [],
    nextConversationError: "",
    nextConversationToolError: "",
    imageHistoryError: "",
    qqOnline: true,
    qrVersion: 1,
    tokenUsage: structuredClone(tokenUsageFixture),
    tokenUsageRequests: [],
    webChatMessages: structuredClone(initialWebChatMessages),
    webChatRequests: [],
    conversationTools: {},
    conversationToolRequests: [],
    conversationReplySettings: {
      "group:10001": { replyEnabled: true, orchestratorEnabled: true },
      "private:20002": { replyEnabled: true }
    },
    conversationReplyRequests: [],
    extensions: {
      plana: {
        skills: [mockSkill("status-report", "unapproved")],
        servers: [mockMcpServer("workspace-search")]
      },
      arona: { skills: [], servers: [] }
    },
    extensionRequests: [],
    mcpApprovals: [mockMcpApproval()],
    selfieReferences: [
      selfieReference("01-neutral-face.png", "常服正面", 458, 501, 241_664),
      selfieReference("02-gentle-smile.png", "温柔微笑", 458, 501, 244_736),
      selfieReference("03-full-outfit.jpg", "制服全身", 1200, 1393, 441_344)
    ],
    voiceProfiles: structuredClone(initialVoiceProfiles),
    voiceProvider: structuredClone(readyVoiceProvider),
    voiceServiceRequests: []
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
      const expectedPassword = state.requiredToken || state.adminPassword;
      if (body.username === "admin" && body.password === expectedPassword) {
        state.authenticated = true;
        return json(route, { authenticated: true, username: "admin", csrfToken: "mock-csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
      }
      return json(route, { error: { code: "ADMIN_UNAUTHORIZED", message: "管理员账号或密码无效。" } }, 401);
    }
    if (pathname === "/api/auth/logout" && method === "POST") {
      state.authenticated = false;
      return route.fulfill({ status: 204 });
    }
    if (pathname === "/api/auth/password" && method === "POST") {
      const body = request.postDataJSON() as { currentPassword: string; newPassword: string; confirmPassword: string };
      if (body.currentPassword !== state.adminPassword) {
        return json(route, { error: { code: "ADMIN_CURRENT_PASSWORD_INVALID", message: "当前密码不正确。", field: "currentPassword" } }, 400);
      }
      if (body.newPassword.length < 12) {
        return json(route, { error: { code: "ADMIN_PASSWORD_TOO_SHORT", message: "新密码至少需要 12 个字符。", field: "newPassword" } }, 400);
      }
      if (body.newPassword !== body.confirmPassword) {
        return json(route, { error: { code: "ADMIN_PASSWORD_MISMATCH", message: "两次输入的新密码不一致。", field: "confirmPassword" } }, 400);
      }
      state.passwordChanges.push(body);
      state.adminPassword = body.newPassword;
      return json(route, { authenticated: true, username: "admin", csrfToken: "rotated-mock-csrf", expiresAt: "2099-02-01T00:00:00.000Z" });
    }

    if (state.requiredToken && !state.authenticated) {
      return json(route, {
        error: { code: "ADMIN_UNAUTHORIZED", message: "管理员会话无效或已过期。" }
      }, 401);
    }

    if (pathname === "/api/voice-profile/probe" && method === "POST") {
      return json(route, { provider: state.voiceProvider });
    }
    const voiceServiceMatch = pathname.match(
      /^\/api\/voice-service\/(check|start|stop)$/u,
    );
    if (voiceServiceMatch && method === "POST") {
      const action = voiceServiceMatch[1]!;
      state.voiceServiceRequests.push(action);
      state.voiceProvider =
        action === "stop"
          ? {
              provider: "MOSS-TTS-Nano",
              ready: false,
              checkedAt: "2026-07-19T01:01:00.000Z",
              serviceState: "stopped",
              controlsAvailable: true,
              message: "语音服务已关闭。"
            }
          : structuredClone(readyVoiceProvider);
      return json(route, { provider: state.voiceProvider });
    }
    if (pathname === "/api/voice-profile") {
      const agentId = url.searchParams.get("agentId") || "plana";
      const profile = state.voiceProfiles[agentId] ?? structuredClone(initialVoiceProfiles.plana!);
      state.voiceProfiles[agentId] = profile;
      if (method === "GET")
        return json(route, { profile, provider: state.voiceProvider });
      if (method === "PUT") {
        const body = request.postDataJSON() as Pick<VoiceProfile, "enabled" | "defaultLanguage">;
        Object.assign(profile, { enabled: body.enabled, defaultLanguage: body.defaultLanguage });
        return json(route, { profile });
      }
    }
    const voiceReferenceMatch = pathname.match(/^\/api\/voice-profile\/(zh|en|ja)$/u);
    if (voiceReferenceMatch) {
      const agentId = url.searchParams.get("agentId") || "plana";
      const language = voiceReferenceMatch[1] as "zh" | "en" | "ja";
      const profile = state.voiceProfiles[agentId] ?? structuredClone(initialVoiceProfiles.plana!);
      state.voiceProfiles[agentId] = profile;
      if (method === "DELETE") {
        profile.languages[language] = null;
        return json(route, { profile });
      }
      if (method === "PUT") {
        const body = request.postDataJSON() as { fileName: string; dataBase64: string; referenceText: string };
        profile.languages[language] = {
          language,
          fileName: body.fileName,
          relativePath: `voice/references/mock-${language}-${"b".repeat(64)}.wav`,
          mimeType: "audio/wav",
          sizeBytes: Math.max(1, Math.floor(body.dataBase64.length * 0.75)),
          sha256: "b".repeat(64),
          referenceText: body.referenceText,
          updatedAt: "2026-07-19T02:00:00.000Z"
        };
        return json(route, { profile });
      }
    }

    if (pathname === "/api/agent-extensions" && method === "GET") {
      const agentId = url.searchParams.get("agentId") || "plana";
      const extensions = state.extensions[agentId] ?? { skills: [], servers: [] };
      return json(route, {
        schemaVersion: 1,
        agentId,
        skills: extensions.skills,
        mcp: {
          servers: extensions.servers,
          secrets: {
            configuredKeys: [`SUNABOT_MCP_STDIO_SECRET_${"A".repeat(32)}`],
            missingKeys: [`SUNABOT_MCP_HTTP_BEARER_${"B".repeat(32)}`]
          }
        }
      });
    }
    if (pathname === "/api/agent-extensions/mcp/runtime/status" && method === "GET") {
      const agentId = url.searchParams.get("agentId") || "plana";
      return json(route, {
        servers: (state.extensions[agentId]?.servers ?? []).filter((server) => server.enabled).map((server) => ({
          serverId: server.id,
          status: "ready",
          toolCatalogStatus: "ready",
          instructions: "[External MCP input] Workspace tools"
        }))
      });
    }
    if (pathname === "/api/agent-extensions/mcp/runtime/approvals" && method === "GET") {
      const agentId = url.searchParams.get("agentId") || "plana";
      return json(route, { approvals: state.mcpApprovals.filter((ticket) => ticket.agentId === agentId) });
    }
    if (pathname === "/api/agent-extensions/mcp/runtime/approvals/approve" && method === "POST") {
      const body = request.postDataJSON() as { agentId: string; ticketId: string };
      state.extensionRequests.push({ method, path: pathname, body });
      state.mcpApprovals = state.mcpApprovals.filter((ticket) => ticket.id !== body.ticketId);
      return json(route, { ok: true });
    }
    if (pathname === "/api/agent-extensions/skills" && method === "POST") {
      const body = request.postDataJSON() as { agentId: string; archiveBase64: string; replace?: boolean };
      state.extensionRequests.push({ method, path: pathname, body: { ...body, archiveBase64: "[BASE64]" } });
      const installed = mockSkill("installed-skill", "unapproved");
      const target = state.extensions[body.agentId] ??= { skills: [], servers: [] };
      target.skills = body.replace
        ? [...target.skills.filter((skill) => skill.id !== installed.id), installed]
        : [...target.skills, installed];
      return json(route, installed, 201);
    }
    const skillReviewMatch = pathname.match(/^\/api\/agent-extensions\/skills\/([^/]+)\/review$/);
    if (skillReviewMatch && method === "POST") {
      const body = request.postDataJSON() as { agentId: string; approve: true };
      const skill = state.extensions[body.agentId]?.skills.find((item) => item.id === decodeURIComponent(skillReviewMatch[1]));
      if (!skill) return json(route, { error: { code: "SKILL_NOT_FOUND", message: "Skill 不存在。" } }, 404);
      Object.assign(skill.riskEvidence, { reviewStatus: "approved", reviewedDigestSha256: skill.digestSha256 });
      skill.approval = { status: "approved", digestSha256: skill.digestSha256, approvedAt: "2026-07-17T00:01:00.000Z" };
      return json(route, skill);
    }
    if (pathname === "/api/agent-extensions/skills/copy/preview" && method === "POST") {
      const body = request.postDataJSON() as { sourceAgentId: string; targetAgentId: string; skillId: string; mcpServerIds?: string[] };
      const skill = state.extensions[body.sourceAgentId]?.skills.find((item) => item.id === body.skillId) ?? mockSkill(body.skillId, "approved");
      const sourceServers = state.extensions[body.sourceAgentId]?.servers ?? [];
      const targetServers = state.extensions[body.targetAgentId]?.servers ?? [];
      const selectedMcpServers: Array<SkillCopyPreview["selectedMcpServers"][number]> = [];
      for (const serverId of body.mcpServerIds ?? []) {
        const source = sourceServers.find((server) => server.id === serverId);
        if (!source) return json(route, { error: { code: "MCP_SERVER_NOT_FOUND", message: `MCP 服务不存在：${serverId}。` } }, 404);
        const server = migratedMockMcpServer(source);
        const target = targetServers.find((candidate) => candidate.id === serverId);
        const sourceSecretKeys = mockMcpSecretKeys(source, body.sourceAgentId);
        const targetSecretKeys = mockMcpSecretKeys(source, body.targetAgentId);
        selectedMcpServers.push({
          server,
          descriptorVersion: "c".repeat(64),
          conflict: target ? JSON.stringify(target) === JSON.stringify(server) ? "same-content" : "different-content" : "none",
          sourceSecrets: { configuredKeys: sourceSecretKeys, missingKeys: [] },
          targetSecrets: { configuredKeys: [], missingKeys: targetSecretKeys },
          targetState: "disabled" as const,
          requiresAuthorization: sourceSecretKeys.length > 0 || server.migrationStatus === "reauthorization_required"
        });
      }
      state.extensionRequests.push({ method, path: pathname, body });
      return json(route, {
        schemaVersion: 1,
        previewRevision: skillCopyPreviewRevision,
        sourceAgentId: body.sourceAgentId,
        targetAgentId: body.targetAgentId,
        sourceSkillRevision: skillCopyRevisions.sourceSkill,
        targetSkillRevision: skillCopyRevisions.targetSkill,
        sourceMcpRevision: skillCopyRevisions.sourceMcp,
        targetMcpRevision: skillCopyRevisions.targetMcp,
        skill: {
          record: skill,
          contentVersion: skill.digestSha256,
          files: [{ path: "SKILL.md", bytes: 512, sha256: "b".repeat(64) }],
          conflict: "none",
          declaredMcpDependencies: skill.riskEvidence.mcpDependencies,
          declaredMcpDependenciesStatus: "declared",
          missingMcpDependencies: []
        },
        selectedMcpServers
      });
    }
    if (pathname === "/api/agent-extensions/skills/copy" && method === "POST") {
      const body = request.postDataJSON() as {
        sourceAgentId: string;
        targetAgentId: string;
        skillId: string;
        mcpServerIds?: string[];
        previewRevision?: string;
        conflictStrategy?: string;
        renameTo?: string;
      };
      const previewRequest = [...state.extensionRequests].reverse().find((entry) => entry.path === "/api/agent-extensions/skills/copy/preview")?.body as {
        sourceAgentId?: string;
        targetAgentId?: string;
        skillId?: string;
        mcpServerIds?: string[];
      } | undefined;
      const matchesPreview = previewRequest
        && previewRequest.sourceAgentId === body.sourceAgentId
        && previewRequest.targetAgentId === body.targetAgentId
        && previewRequest.skillId === body.skillId
        && JSON.stringify(previewRequest.mcpServerIds ?? []) === JSON.stringify(body.mcpServerIds ?? []);
      if (body.previewRevision !== skillCopyPreviewRevision || !matchesPreview) {
        return json(route, { error: { code: "AGENT_EXTENSION_COPY_PREVIEW_STALE", message: "迁移预览已失效。" } }, 409);
      }
      if (!body.conflictStrategy || !["skip", "replace", "rename"].includes(body.conflictStrategy)) {
        return json(route, { error: { code: "AGENT_EXTENSION_VALUE_INVALID", message: "conflictStrategy 无效。", field: "conflictStrategy" } }, 400);
      }
      if (body.conflictStrategy === "rename" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(body.renameTo ?? "")) {
        return json(route, { error: { code: "AGENT_EXTENSION_VALUE_INVALID", message: "renameTo 无效。", field: "renameTo" } }, 400);
      }
      state.extensionRequests.push({ method, path: pathname, body });
      const source = state.extensions[body.sourceAgentId]?.skills.find((item) => item.id === body.skillId);
      const target = state.extensions[body.targetAgentId] ??= { skills: [], servers: [] };
      const existing = target.skills.find((item) => item.id === body.skillId);
      const skipped = body.conflictStrategy === "skip" && Boolean(existing);
      const copied = source && !skipped ? structuredClone(source) : null;
      if (copied) {
        copied.id = body.renameTo || copied.id;
        copied.name = copied.id;
        copied.enabled = false;
        copied.source = { kind: "copy", agentId: body.sourceAgentId, skillId: body.skillId };
        target.skills = [...target.skills.filter((skill) => skill.id !== copied.id), copied];
      }
      const copiedServers = (body.mcpServerIds ?? []).flatMap((serverId) => {
        const server = state.extensions[body.sourceAgentId]?.servers.find((candidate) => candidate.id === serverId);
        return server ? [migratedMockMcpServer(server)] : [];
      });
      target.servers = [...target.servers.filter((server) => !copiedServers.some((copiedServer) => copiedServer.id === server.id)), ...copiedServers];
      return json(route, {
        schemaVersion: 1,
        sourceAgentId: body.sourceAgentId,
        targetAgentId: body.targetAgentId,
        skill: copied,
        skipped,
        mcpServers: copiedServers
      });
    }
    const skillMatch = pathname.match(/^\/api\/agent-extensions\/skills\/([^/]+)$/);
    if (skillMatch && method === "PATCH") {
      const body = request.postDataJSON() as { agentId: string; enabled: boolean };
      const skill = state.extensions[body.agentId]?.skills.find((item) => item.id === decodeURIComponent(skillMatch[1]));
      if (!skill) return json(route, { error: { code: "SKILL_NOT_FOUND", message: "Skill 不存在。" } }, 404);
      skill.enabled = body.enabled;
      return json(route, skill);
    }
    if (skillMatch && method === "DELETE") {
      const agentId = url.searchParams.get("agentId") || "plana";
      const skillId = decodeURIComponent(skillMatch[1]);
      const target = state.extensions[agentId] ??= { skills: [], servers: [] };
      const skill = target.skills.find((item) => item.id === skillId) ?? mockSkill(skillId, "unapproved");
      target.skills = target.skills.filter((item) => item.id !== skillId);
      return json(route, skill);
    }
    if (pathname === "/api/agent-extensions/mcp/servers/preview" && method === "POST") {
      const body = request.postDataJSON() as { agentId: string; server: AgentMcpServer };
      return json(route, {
        schemaVersion: 1,
        previewRevision: "c".repeat(64),
        server: body.server,
        commandApproval: body.server.transport === "stdio" ? {
          required: true,
          command: body.server.command,
          args: body.server.args,
          digestSha256: "d".repeat(64)
        } : null
      });
    }
    if (pathname === "/api/agent-extensions/mcp/servers" && method === "PUT") {
      const body = request.postDataJSON() as { agentId: string; server: AgentMcpServer; replace?: boolean };
      state.extensionRequests.push({ method, path: pathname, body });
      const target = state.extensions[body.agentId] ??= { skills: [], servers: [] };
      target.servers = [...target.servers.filter((server) => server.id !== body.server.id), body.server];
      return json(route, body.server);
    }
    const mcpServerMatch = pathname.match(/^\/api\/agent-extensions\/mcp\/servers\/([^/]+)$/);
    if (mcpServerMatch && method === "PATCH") {
      const body = request.postDataJSON() as { agentId: string; enabled: boolean };
      const server = state.extensions[body.agentId]?.servers.find((item) => item.id === decodeURIComponent(mcpServerMatch[1]));
      if (!server) return json(route, { error: { code: "MCP_SERVER_NOT_FOUND", message: "MCP 服务不存在。" } }, 404);
      server.enabled = body.enabled;
      return json(route, server);
    }
    if (mcpServerMatch && method === "DELETE") {
      const agentId = url.searchParams.get("agentId") || "plana";
      const serverId = decodeURIComponent(mcpServerMatch[1]);
      const target = state.extensions[agentId] ??= { skills: [], servers: [] };
      const server = target.servers.find((item) => item.id === serverId) ?? mockMcpServer(serverId);
      target.servers = target.servers.filter((item) => item.id !== serverId);
      return json(route, server);
    }
    if (pathname === "/api/agent-extensions/mcp/runtime/catalog" && method === "GET") {
      return json(route, {
        digestSha256: "e".repeat(64),
        tools: [{ name: "search", description: "[External MCP input] Search the workbench" }],
        resources: [{ uri: "file:///workbench/README.md" }],
        resourceTemplates: [],
        prompts: [{ name: "summarize" }],
        refreshedAt: "2026-07-17T00:02:00.000Z"
      });
    }
    if (pathname === "/api/agent-extensions/mcp/oauth/begin" && method === "POST") {
      return json(route, { authorizationUrl: "https://auth.example.test/authorize", authorizationOrigin: "https://auth.example.test", expiresAt: "2026-07-17T00:10:00.000Z" });
    }
    if ((pathname === "/api/agent-extensions/mcp/oauth/refresh" || pathname === "/api/agent-extensions/mcp/oauth/revoke") && method === "POST") {
      return json(route, { ok: true });
    }

    if (pathname === "/api/agents" && method === "GET") return json(route, { agents: state.agents });
    if (pathname === "/api/agents" && method === "POST") {
      const body = request.postDataJSON() as {
        id: string;
        name: string;
        avatar?: { fileName?: string; dataBase64?: string };
      };
      const created: MockAgent = {
        id: body.id,
        name: body.name,
        enabled: true,
        workspace: `workspace/business/agents/${body.id}`,
        ...(body.avatar ? { avatarPath: "assets/avatar.png" } : {}),
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:00:00.000Z",
        runtime: { loaded: true, persona: { id: body.id, name: body.name, memoryItems: 0 } },
        accounts: []
      };
      state.agents.push(created);
      return json(route, created);
    }
    const agentPromptSettingsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/prompt-settings$/);
    if (agentPromptSettingsMatch) {
      const agentId = decodeURIComponent(agentPromptSettingsMatch[1]);
      if (method === "GET") return json(route, { overrideSystem: state.promptOverrides[agentId] === true });
      if (method === "PATCH") {
        const body = request.postDataJSON() as { overrideSystem?: boolean };
        state.promptOverrides[agentId] = body.overrideSystem === true;
        return json(route, { overrideSystem: state.promptOverrides[agentId] });
      }
    }
    const agentAvatarMatch = pathname.match(/^\/api\/agents\/([^/]+)\/avatar$/);
    if (agentAvatarMatch && method === "PUT") {
      const agentId = decodeURIComponent(agentAvatarMatch[1]);
      const agent = state.agents.find((item) => item.id === agentId);
      if (!agent) return json(route, { error: { code: "AGENT_NOT_FOUND", message: "Agent 不存在。" } }, 404);
      const body = request.postDataJSON() as { avatar: { fileName: string; dataBase64: string } };
      state.avatarUpdates.push({ agentId, fileName: body.avatar.fileName, dataBase64: body.avatar.dataBase64 });
      agent.avatarPath = `assets/avatar-${state.avatarUpdates.length}.png`;
      agent.updatedAt = `2026-07-13T08:00:0${state.avatarUpdates.length}.000Z`;
      return json(route, agent);
    }
    if (agentAvatarMatch && method === "GET") {
      return route.fulfill({ status: 200, contentType: "image/png", body: await imageFixture });
    }
    const agentAccountCollectionMatch = pathname.match(/^\/api\/agents\/([^/]+)\/accounts$/);
    if (agentAccountCollectionMatch && method === "POST") {
      const agentId = decodeURIComponent(agentAccountCollectionMatch[1]);
      const agent = state.agents.find((item) => item.id === agentId);
      if (!agent) return json(route, { error: { code: "AGENT_NOT_FOUND", message: "Agent 不存在。" } }, 404);
      const body = request.postDataJSON() as { label: string };
      const accountId = `qq_mock_${state.agents.flatMap((item) => item.accounts).length + 1}`;
      const registeredAccount = {
        id: accountId,
        agentId,
        label: body.label,
        enabled: true,
        webuiPort: 6099 + state.agents.flatMap((item) => item.accounts).length,
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:00:00.000Z"
      };
      const runtimeState = {
        schemaVersion: 1,
        accountId,
        desiredState: "running" as const,
        observedState: "missing" as const,
        reconcileRequired: true,
        lastError: null,
        updatedAt: "2026-07-13T08:00:00.000Z"
      };
      const account = {
        ...registeredAccount,
        ...runtimeState,
        connected: false,
        runtimeReady: false
      };
      agent.accounts.push(account);
      return json(route, { ...registeredAccount, ...runtimeState });
    }
    const agentAccountRuntimeStartMatch = pathname.match(/^\/api\/agents\/([^/]+)\/accounts\/([^/]+)\/runtime\/start$/);
    if (agentAccountRuntimeStartMatch && method === "POST") {
      const agentId = decodeURIComponent(agentAccountRuntimeStartMatch[1]);
      const accountId = decodeURIComponent(agentAccountRuntimeStartMatch[2]);
      const account = state.agents.find((item) => item.id === agentId)?.accounts.find((item) => item.id === accountId);
      if (!account) return json(route, { error: { code: "AGENT_ACCOUNT_NOT_FOUND", message: "QQ 账号不存在。" } }, 404);
      Object.assign(account, {
        enabled: true,
        desiredState: "running",
        observedState: "running",
        reconcileRequired: false,
        runtimeReady: true,
        lastError: null,
        updatedAt: "2026-07-13T08:00:01.000Z"
      });
      return json(route, account);
    }
    const agentAccountMatch = pathname.match(/^\/api\/agents\/([^/]+)\/accounts\/([^/]+)$/);
    if (agentAccountMatch && method === "DELETE") {
      const agentId = decodeURIComponent(agentAccountMatch[1]);
      const accountId = decodeURIComponent(agentAccountMatch[2]);
      const agent = state.agents.find((item) => item.id === agentId);
      if (agent) agent.accounts = agent.accounts.filter((item) => item.id !== accountId);
      return json(route, { ok: true });
    }
    const agentLoginMatch = pathname.match(/^\/api\/agents\/([^/]+)\/accounts\/([^/]+)\/login(?:\/status)?$/);
    if (agentLoginMatch) {
      const accountId = decodeURIComponent(agentLoginMatch[2]);
      const account = state.agents.flatMap((item) => item.accounts).find((item) => item.id === accountId);
      const online = Boolean(account?.connected && !(account.id === "primary" && state.offline));
      if (method === "POST" && !online) state.qrVersion += 1;
      const qr = (await imageFixture).toString("base64");
      return json(route, {
        connected: online,
        online,
        available: true,
        phase: online ? "online" : "waiting_scan",
        ...(account?.qqId ? { data: { user_id: Number(account.qqId), nickname: account.label } } : {}),
        ...(online ? {} : { imageDataUrl: `data:image/png;base64,${qr}`, imageUpdatedAt: "2026-07-13T08:00:00.000Z" })
      });
    }
    const agentLogoutMatch = pathname.match(/^\/api\/agents\/([^/]+)\/accounts\/([^/]+)\/logout$/);
    if (agentLogoutMatch && method === "POST") {
      const accountId = decodeURIComponent(agentLogoutMatch[2]);
      const account = state.agents.flatMap((item) => item.accounts).find((item) => item.id === accountId);
      if (account) account.connected = false;
      state.qqOnline = false;
      state.offline = true;
      state.qrVersion += 1;
      return json(route, { connected: false, online: false, available: true, phase: "restarting" });
    }
    const agentChatsMatch = pathname.match(/^\/api\/agents\/([^/]+)\/accounts\/([^/]+)\/chats$/);
    if (agentChatsMatch) return json(route, { connected: false, private: [], groups: [] });
    const agentNapcatMatch = pathname.match(/^\/api\/agents\/([^/]+)\/accounts\/([^/]+)\/napcat-webui-url$/);
    if (agentNapcatMatch) return json(route, { url: "http://127.0.0.1:6100/webui/" });
    const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
    if (agentMatch) {
      const id = decodeURIComponent(agentMatch[1]);
      const agent = state.agents.find((item) => item.id === id);
      if (!agent) return json(route, { error: { code: "AGENT_NOT_FOUND", message: "Agent 不存在。" } }, 404);
      if (method === "DELETE") {
        const body = request.postDataJSON() as { confirmation?: string };
        if (body.confirmation !== "确认删除") {
          return json(route, { error: { code: "AGENT_DELETE_CONFIRMATION_REQUIRED", message: "请输入“确认删除”以删除 Bot。" } }, 400);
        }
        if (id === "plana") return json(route, { error: { code: "PRIMARY_AGENT_REQUIRED", message: "主 Bot 不能删除。" } }, 409);
        state.agents = state.agents.filter((item) => item.id !== id);
        return json(route, { ok: true });
      }
      if (method === "PATCH") {
        const body = request.postDataJSON() as { name?: string; enabled?: boolean };
        Object.assign(agent, body, { updatedAt: "2026-07-13T08:01:00.000Z" });
      }
      return json(route, agent);
    }

    if (pathname === "/api/media/image" || pathname === "/api/media/qq-avatar" || pathname === "/api/media/thumbnail") {
      return route.fulfill({ status: 200, contentType: "image/png", body: await imageFixture });
    }

    if (/^\/api\/selfie-references\/[^/]+\/content$/.test(pathname)) {
      return route.fulfill({ status: 200, contentType: "image/png", body: await imageFixture });
    }
    if (pathname === "/api/selfie-references" && method === "GET") {
      return json(route, { images: state.selfieReferences, maxImages: 9 });
    }
    if (pathname === "/api/selfie-references" && method === "POST") {
      if (state.selfieReferences.length >= 9) {
        return json(route, { error: { code: "SELFIE_REFERENCE_LIMIT", message: "最多保留 9 张参考图。" } }, 409);
      }
      const body = request.postDataJSON() as { fileName?: string; note?: string };
      const note = body.note?.trim() ?? "";
      if (!note) {
        return json(route, { error: { code: "SELFIE_REFERENCE_NOTE_INVALID", message: "自拍参考图备注无效。" } }, 400);
      }
      state.selfieReferences.push(selfieReference(body.fileName || "reference.png", note, 640, 640, 16_384));
      return json(route, { images: state.selfieReferences, maxImages: 9 }, 201);
    }
    const selfieReferenceMatch = pathname.match(/^\/api\/selfie-references\/([^/]+)$/);
    if (selfieReferenceMatch && method === "PATCH") {
      const id = decodeURIComponent(selfieReferenceMatch[1]);
      const body = request.postDataJSON() as { note?: string };
      const note = body.note?.trim() ?? "";
      const reference = state.selfieReferences.find((image) => image.id === id);
      if (!reference || !note) {
        return json(route, { error: { code: "SELFIE_REFERENCE_NOTE_INVALID", message: "自拍参考图备注无效。" } }, 400);
      }
      reference.note = note;
      return json(route, { images: state.selfieReferences, maxImages: 9 });
    }
    if (selfieReferenceMatch && method === "DELETE") {
      const id = decodeURIComponent(selfieReferenceMatch[1]);
      state.selfieReferences = state.selfieReferences.filter((image) => image.id !== id);
      return route.fulfill({ status: 204 });
    }

    if (pathname === "/api/codex-auth/status") {
      return json(route, { installed: true, authenticated: false, login: { state: "idle" } });
    }

    if (pathname === "/api/token-usage") {
      const model = url.searchParams.get("model") ?? "";
      const behavior = url.searchParams.get("behavior") ?? "";
      state.tokenUsageRequests.push(url.search);
      return json(route, filteredTokenUsage(state.tokenUsage, model, behavior));
    }

    if (pathname === "/api/model-call-stats") {
      return json(route, modelCallStats());
    }

    if (pathname === "/api/monitoring/settings") {
      if (method === "GET") return json(route, state.monitoringSettings);
      const body = request.postDataJSON() as Record<string, unknown>;
      state.monitoringWrites.push(body);
      if (state.nextMonitoringError) {
        const message = state.nextMonitoringError;
        state.nextMonitoringError = "";
        return json(route, { error: { code: "MONITORING_INVALID", message } }, 400);
      }
      if (typeof body.aggregationWindowSeconds === "number") state.monitoringSettings.aggregationWindowSeconds = body.aggregationWindowSeconds;
      if (typeof body.onebotOfflineGraceSeconds === "number") state.monitoringSettings.onebotOfflineGraceSeconds = body.onebotOfflineGraceSeconds;
      if (typeof body.heartbeatStaleSeconds === "number") state.monitoringSettings.heartbeatStaleSeconds = body.heartbeatStaleSeconds;
      if (typeof body.serverEventsEnabled === "boolean") state.monitoringSettings.serverEventsEnabled = body.serverEventsEnabled;
      if (typeof body.onebotEventsEnabled === "boolean") state.monitoringSettings.onebotEventsEnabled = body.onebotEventsEnabled;
      if (typeof body.barkUrl === "string" && body.barkUrl.trim()) state.monitoringSettings.barkConfigured = true;
      if (body.clearBarkUrl === true) state.monitoringSettings.barkConfigured = false;
      return json(route, state.monitoringSettings);
    }
    if (pathname === "/api/monitoring/test") return json(route, { ok: true });

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

    if (pathname === "/api/config-doctor/scan" && method === "GET") {
      state.doctorRequests.push({ method, path: pathname });
      return json(route, configDoctorReport(state));
    }
    if (pathname === "/api/config-doctor/propose" && method === "POST") {
      const body = request.postDataJSON() as { sourceRevision?: string };
      state.doctorRequests.push({ method, path: pathname, body });
      if (body.sourceRevision !== state.doctorRevision) {
        return json(route, {
          error: {
            code: "CONFIG_REVISION_CONFLICT",
            message: "配置已变化，请重新检查。",
            latestRevision: state.doctorRevision
          }
        }, 409);
      }
      state.doctorProposalSource = "ai";
      return json(route, configDoctorReport(state));
    }
    if (pathname === "/api/config-doctor/apply" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.doctorRequests.push({ method, path: pathname, body });
      const expectedProposalId = state.doctorProposalSource === "ai" ? "doctor-ai-r1" : "doctor-rules-r1";
      if (
        Object.keys(body).length !== 2
        || body.proposalId !== expectedProposalId
        || body.sourceRevision !== state.doctorRevision
      ) {
        return json(route, {
          error: { code: "CONFIG_DOCTOR_REQUEST_INVALID", message: "修复请求无效。" }
        }, 400);
      }
      state.doctorHealthy = true;
      state.doctorRevision = "doctor-r2";
      return json(route, {
        ok: true,
        repairId: "repair-e2e-1",
        repairedAt: "2026-07-16T08:02:00.000Z",
        sourceRevision: state.doctorRevision,
        backupPath: "backups/config-doctor/repair-e2e-1/before.json",
        restartRequired: false,
        appliedChanges: 1
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
      const agentId = url.searchParams.get("agentId") || "plana";
      const visible = state.promptOverrides[agentId]
        ? state.files
        : state.files.filter((item) => item.kind === "fragment" || item.id === "image.selfie-rewrite");
      return json(route, { files: visible.map(({ content: _content, ...metadata }) => metadata) });
    }
    if (pathname === "/api/system-prompt-files" && method === "GET") {
      const files = state.files.filter((item) => item.kind === "final" && item.id !== "image.selfie-rewrite");
      return json(route, { files: files.map(({ content: _content, ...metadata }) => metadata) });
    }
    const fileMatch = pathname.match(/^\/api\/(?:agent-files|system-prompt-files)\/(.+)$/);
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
            ...state.conversationReplySettings["group:10001"],
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
            ...state.conversationReplySettings["private:20002"],
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
            at: "2026-07-10T02:01:00.000Z",
            logRunId: "run-model-update",
            messageOrigin: "text",
            toolNames: ["memory_recall", "websearch", "memory_recall"]
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
      const runId = url.searchParams.get("runId");
      return json(route, {
        logs: runId === "running-run" || runId === "run-model-update"
          ? [
              {
                id: `${runId}-request`,
                at: "2026-07-10T02:02:00.000Z",
                category: "model.request",
                action: "responses.complete",
                request: { input: [{ role: "system", content: [{ type: "input_text", text: "完整最终提示词 Alpha" }] }] },
                metadata: { runId, conversationId: "group:10001" }
              },
              {
                id: `${runId}-response`,
                at: "2026-07-10T02:02:01.000Z",
                category: "model.response",
                action: "responses.complete",
                response: { ok: true, payload: { output_text: "模型返回正文 Beta" } },
                metadata: { runId, conversationId: "group:10001" }
              },
              {
                id: `${runId}-log`,
                at: "2026-07-10T02:02:02.000Z",
                category: "runtime.action",
                action: "reply.started",
                response: { status: "running" },
                metadata: { runId, conversationId: "group:10001" }
              }
            ]
          : []
      });
    }
    if (/^\/api\/conversations\/[^/]+\/stats$/.test(pathname)) {
      const conversationId = decodeURIComponent(pathname.split("/")[3] ?? "");
      return json(route, {
        conversationId,
        messages: {
          total: 24,
          retained: 24,
          visible: 21,
          user: 17,
          assistant: 4,
          internal: 3
        },
        modelCalls: modelCallStats(conversationId)
      });
    }
    if (/^\/api\/conversations\/[^/]+\/tools$/.test(pathname)) {
      const conversationId = decodeURIComponent(pathname.split("/")[3] ?? "");
      if (method === "PUT") {
        if (state.nextConversationToolError) {
          const message = state.nextConversationToolError;
          state.nextConversationToolError = "";
          return json(route, { error: { code: "CONVERSATION_TOOL_UPDATE_FAILED", message } }, 500);
        }
        const body = request.postDataJSON() as { disabledTools?: string[] };
        const disabledTools = Array.isArray(body.disabledTools) ? [...body.disabledTools] : [];
        state.conversationTools[conversationId] = disabledTools;
        state.conversationToolRequests.push({ conversationId, disabledTools });
      }
      return json(route, {
        conversationId,
        disabledTools: state.conversationTools[conversationId] ?? []
      });
    }
    if (pathname === "/api/conversations/reply") {
      if (state.nextConversationError) {
        const message = state.nextConversationError;
        state.nextConversationError = "";
        return json(route, { error: { code: "CONVERSATION_UPDATE_FAILED", message } }, 500);
      }
      const body = request.postDataJSON() as { id?: string; replyEnabled?: boolean; orchestratorEnabled?: boolean };
      const id = body.id ?? "group:10001";
      const previous = state.conversationReplySettings[id] ?? { replyEnabled: true };
      const next = {
        replyEnabled: body.replyEnabled ?? previous.replyEnabled,
        ...(body.orchestratorEnabled === undefined && previous.orchestratorEnabled === undefined
          ? {}
          : { orchestratorEnabled: body.orchestratorEnabled ?? previous.orchestratorEnabled ?? true })
      };
      state.conversationReplySettings[id] = next;
      state.conversationReplyRequests.push({ conversationId: id, ...next });
      const conversation = {
        id,
        scope: id.startsWith("private:") ? "private" : "user_group",
        title: id.startsWith("private:") ? "猫老师" : "产品讨论群",
        userId: 20002,
        ...(id.startsWith("private:") ? {} : { groupId: 10001 }),
        lastText: "模型目录已经更新。",
        lastAt: "2026-07-10T02:20:00.000Z",
        ...next,
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
      const conversationPrompt = state.files.find((file) => file.id === "conversation.private-reply");
      const prompt = conversationPrompt ? parseFinalPromptTemplate(conversationPrompt.content) : undefined;
      const tools = listToolMetadata({
        onAssistantText: () => undefined,
        allowNoReply: true,
        bashAvailable: true,
        bot: state.config.bot,
        selfie: { enabled: true },
        memory: { enabled: true },
        asyncCodex: true,
        asyncImage: true,
        skillCapabilities: BUILTIN_SKILL_TOOL_CAPABILITIES
      }, prompt?.tools).map((tool) => tool.name === "workspace_bash"
        ? {
            ...tool,
            accessLabel: state.config.bot.bash.allowGroup
              ? "管理员 QQ 私聊与群聊"
              : "仅管理员 QQ 私聊",
            accessDescription: state.config.bot.bash.allowGroup
              ? "私聊使用所选后端。群聊固定使用 Docker 受限模式。Web Chat 和普通用户不可用。"
              : "私聊使用所选后端。群聊未开启。Web Chat 和普通用户不可用。",
            executionBackend: state.config.bot.bash.adminPrivateBackend
          }
        : tool).map((tool) => {
        const configured = tool.name === "workspace_bash"
          ? state.config.bot.bash.enabled
          : tool.name === "codex"
            ? state.config.bot.tools.codex.enabled
            : undefined;
        return configured == null
          ? tool
          : {
              ...tool,
              configuredEnabled: configured,
              enabled: configured && tool.enabled,
              effectiveEnabled: configured && tool.effectiveEnabled
            };
      });
      return json(route, {
        tools
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

function mockSkill(id: string, approval: "unapproved" | "approved"): AgentSkillRecord {
  const digest = "a".repeat(64);
  return {
    id,
    name: id,
    description: "整理当前 Agent 的运行状态并生成简洁报告。",
    license: "MIT",
    compatibility: "Sunabot",
    metadata: { category: "operations" },
    allowedTools: [],
    riskEvidence: {
      reviewVersion: 1,
      reviewStatus: approval === "approved" ? "approved" : "unreviewed",
      reviewedDigestSha256: approval === "approved" ? digest : null,
      classification: "instruction-only",
      hasScripts: false,
      hasExternalUrls: false,
      mcpDependencies: [{
        id: "workspace-search",
        description: "读取工作区目录",
        transport: "streamable_http",
        url: "https://mcp.example.test/v1"
      }],
      declaredFileAccess: ["read"],
      allowImplicitInvocation: false
    },
    enabled: approval === "approved",
    entry: "SKILL.md",
    digestSha256: digest,
    fileCount: 3,
    unpackedBytes: 4_096,
    installedAt: "2026-07-17T00:00:00.000Z",
    source: { kind: "upload" },
    approval: approval === "approved"
      ? { status: "approved", digestSha256: digest, approvedAt: "2026-07-17T00:01:00.000Z" }
      : { status: "unapproved", digestSha256: null, approvedAt: null }
  };
}

function mockMcpServer(id: string): AgentMcpServer {
  return {
    id,
    name: "Workspace Search",
    description: "读取当前 Agent 的工作区资源。",
    enabled: true,
    required: false,
    enabledTools: ["search"],
    disabledTools: [],
    approvalMode: "always",
    transport: "stdio",
    command: "/usr/bin/workspace-mcp",
    args: ["--stdio"],
    envKeys: ["WORKSPACE_SEARCH_TOKEN"]
  };
}

function migratedMockMcpServer(server: AgentMcpServer): AgentMcpServer {
  if (server.transport === "stdio") {
    return server.envKeys.length
      ? { ...server, enabled: false, migrationStatus: "reauthorization_required" }
      : { ...server, enabled: false };
  }
  if (server.auth.kind === "bearer" || server.auth.kind === "oauth") {
    return {
      ...server,
      enabled: false,
      auth: { kind: server.auth.kind, credentialRef: "pending" },
      migrationStatus: "reauthorization_required"
    };
  }
  return { ...server, enabled: false };
}

function mockMcpSecretKeys(server: AgentMcpServer, agentId: string) {
  if (server.transport === "stdio") {
    return server.envKeys.map((key) => mcpStdioCredentialEnvironmentKey(agentId, server.id, key));
  }
  if (server.auth.kind === "bearer") {
    return [mcpHttpCredentialEnvironmentKey(agentId, server.id, server.auth.credentialRef, server.url)];
  }
  return [];
}

function mockMcpApproval(): McpApprovalTicket {
  return {
    id: `mcpa_${"a".repeat(24)}`,
    agentId: "plana",
    accountId: "primary",
    transport: "onebot",
    conversationId: "private:171419991",
    userId: 171419991,
    serverId: "workspace-search",
    toolName: "search",
    snapshotDigest: "a".repeat(64),
    catalogGeneration: 1,
    argumentsDigest: "b".repeat(64),
    arguments: { query: "release status" },
    status: "pending",
    createdAt: "2026-07-17T00:00:00.000Z",
    expiresAt: "2026-07-17T00:10:00.000Z"
  };
}

function configDoctorReport(state: MockApiState) {
  const provider = {
    label: "Codex",
    model: "gpt-5.6-sol",
    destination: "chatgpt.com"
  };
  if (state.doctorHealthy) {
    return {
      schemaVersion: 1,
      generatedAt: "2026-07-16T08:02:01.000Z",
      sourceRevision: state.doctorRevision,
      status: "healthy",
      issues: [],
      ai: { available: true, provider }
    };
  }
  const proposalSource = state.doctorProposalSource;
  return {
    schemaVersion: 1,
    generatedAt: proposalSource === "ai" ? "2026-07-16T08:01:00.000Z" : "2026-07-16T08:00:00.000Z",
    sourceRevision: state.doctorRevision,
    status: "repairable",
    issues: [{
      id: proposalSource === "ai" ? "CONFIG_AI_SUGGESTION_1" : "CONFIG_RULE_REPAIR_1",
      path: "/normalReply/maxRetries",
      message: proposalSource === "ai"
        ? "补齐缺失的正常回复重试次数"
        : "字段 /normalReply/maxRetries 缺失，将使用当前默认值。",
      severity: "warning",
      repairable: true,
      source: proposalSource === "ai" ? "ai" : "rules"
    }],
    proposal: {
      id: proposalSource === "ai" ? "doctor-ai-r1" : "doctor-rules-r1",
      sourceRevision: state.doctorRevision,
      expiresAt: "2026-07-16T08:10:00.000Z",
      risk: "low",
      source: proposalSource,
      changes: [{
        path: "/normalReply/maxRetries",
        action: "add",
        summary: proposalSource === "ai"
          ? "AI 建议补充失败重试次数 3"
          : "补齐字段 /normalReply/maxRetries",
        risk: "low"
      }]
    },
    ai: { available: true, provider }
  };
}

function applySection(config: typeof initialConfig, section: string, value: unknown) {
  const next = structuredClone(value) as Record<string, unknown>;
  if (section === "server" || section === "providers" || section === "broadcastStorm" || section === "normalReply") {
    Object.assign(config[section], next);
    return;
  }
  if (section === "persona") {
    Object.assign(config.persona, next);
    return;
  }
  if (section === "group-reply") {
    config.onebot.autoReplyUserGroup = Boolean(next.enabled);
    Object.assign(config.bot.orchestrator, next.orchestrator as typeof config.bot.orchestrator);
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
  if (section === "tone" || section === "memory" || section === "orchestrator" || section === "bash") {
    Object.assign(config.bot[section], next);
    return;
  }
  if (section === "onebot") Object.assign(config.onebot, next);
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function selfieReference(fileName: string, note: string, width: number, height: number, sizeBytes: number) {
  const id = fileName;
  const path = `/api/selfie-references/${encodeURIComponent(id)}/content`;
  return {
    id,
    fileName,
    note,
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

function modelCallStats(conversationId: string | null = null) {
  const bucket = (requests: number, total: number) => ({
    input: Math.round(total * 0.8),
    output: Math.round(total * 0.2),
    cachedInput: 0,
    cacheRate: null,
    total,
    requests
  });
  return {
    conversationId,
    total: bucket(26, 128_400),
    behavior: {
      reply: bucket(12, 82_000),
      orchestrator: bucket(6, 24_000),
      memory: bucket(7, 21_600),
      other: bucket(1, 800)
    },
    memory: {
      total: bucket(7, 21_600),
      kinds: {
        working_long_term: bucket(5, 16_800),
        user_profile: bucket(2, 4_800)
      }
    },
    models: [
      {
        model: "gpt-5.4-mini",
        total: bucket(20, 96_000),
        behavior: {
          reply: bucket(10, 64_000),
          orchestrator: bucket(4, 16_000),
          memory: bucket(5, 15_200),
          other: bucket(1, 800)
        },
        memory: {
          total: bucket(5, 15_200),
          kinds: {
            working_long_term: bucket(4, 12_000),
            user_profile: bucket(1, 3_200)
          }
        }
      },
      {
        model: "gpt-5.6-terra",
        total: bucket(6, 32_400),
        behavior: {
          reply: bucket(2, 18_000),
          orchestrator: bucket(2, 8_000),
          memory: bucket(2, 6_400),
          other: bucket(0, 0)
        },
        memory: {
          total: bucket(2, 6_400),
          kinds: {
            working_long_term: bucket(1, 4_800),
            user_profile: bucket(1, 1_600)
          }
        }
      }
    ]
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
