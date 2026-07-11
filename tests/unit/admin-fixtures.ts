import path from "node:path";
import type { AppConfig } from "../../src/types.js";

export function createAdminTestConfig(rootDir: string): AppConfig {
  return {
    server: {
      host: "127.0.0.1",
      port: 8787
    },
    persona: {
      defaultAgentId: "plana",
      agentWorkspace: path.join(rootDir, "agent-workspace"),
      memoryLimit: 32
    },
    providers: {
      defaultProviderId: "test-provider",
      items: [
        {
          id: "test-provider",
          label: "Test Provider",
          kind: "openai-responses",
          enabled: true,
          model: "gpt-5.5",
          imageModel: "gpt-image-2",
          baseUrl: "https://example.invalid",
          apiKeyEnv: "SUNABOT_TEST_MISSING_API_KEY",
          temperature: 0.7,
          maxOutputTokens: 2_400,
          reasoningEffort: "medium"
        }
      ]
    },
    bot: {
      adminQq: "171419991",
      adminName: "Test Admin",
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
        enabled: false,
        userGroupchatOrchestratorModel: "gpt-5.4-mini",
        reasoningEffort: "medium",
        promptFile: "user_groupchat_orchestrator.json",
        messageThreshold: 10,
        recentMessageWindowMs: 60_000
      },
      tools: {
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
        generateImg: {
          provider: "codex-image-gen",
          size: "1024x1024",
          resolution: "1K",
          quality: "high"
        }
      },
      bash: {
        enabled: true,
        allowGroup: false,
        adminOnly: true,
        workspaceOnly: true,
        blockedKeywords: ["rm"]
      }
    },
    onebot: {
      reverseWsPath: "/onebot/v11/ws",
      accessTokenEnv: "ONEBOT_ACCESS_TOKEN",
      autoReplyPrivate: true,
      autoReplyUserGroup: true,
      autoReplyBotGroup: false,
      quoteGroupReplies: true,
      mentionNames: ["Plana"],
      commandPrefixes: ["/sunabot"]
    }
  };
}
