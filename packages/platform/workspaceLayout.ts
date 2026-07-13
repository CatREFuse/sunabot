export const WORKSPACE_LAYOUT = {
  config: "business/config/sunabot.json",
  agentRoot: "business/agents",
  defaultAgent: "business/agents/plana",
  systemPrompts: "business/prompts",
  database: "business/data/sunabot.sqlite",
  sessionQueue: "business/data/session-queue.sqlite",
  mediaImages: "business/media/images",
  legacyData: "business/data/legacy",
  attachmentCache: "cache/attachments",
  conversationDirectoryCache: "cache/conversation-directory.json",
  codexJobs: "runtime/tmp/codex-jobs",
  runtimeLogs: "runtime/logs",
  runtimeTemporary: "runtime/tmp",
  napcatState: "runtime/napcat",
  napcatAccounts: "runtime/napcat/accounts",
  legacyNapcatConfig: "runtime/napcat/config-full",
  legacyNapcatQqState: "runtime/napcat/qq",
  legacyNapcatPlugins: "runtime/napcat/plugins",
  legacyNapcatQrCode: "runtime/napcat/qrcode.png",
  legacyNapcatManualLogin: "runtime/napcat/manual-login-required",
  secretsEnv: "secrets/runtime.env",
  adminCredentials: "secrets/admin-credentials.json",
  adminFuse: "secrets/ADMIN_DISABLED.json",
  codexHome: "secrets/codex",
  backups: "backups"
} as const;

export const LEGACY_WORKSPACE_LAYOUT = {
  config: "config/sunabot.json",
  agentRoot: "agents",
  database: "artifacts/sunabot.sqlite",
  sessionQueue: "artifacts/session-queue.sqlite",
  mediaImages: "artifacts/images",
  attachmentCache: "artifacts/file-cache",
  conversationDirectoryCache: "artifacts/conversation-directory.json",
  codexJobs: "artifacts/codex-jobs",
  secretsEnv: ".env",
  security: "security",
  napcatState: "napcat"
} as const;

export function workspaceRelativeReference(relativePath: string) {
  return `workspace/${relativePath.replace(/\\/g, "/")}`;
}
