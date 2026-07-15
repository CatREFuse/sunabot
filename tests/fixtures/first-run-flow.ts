import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { buildApp } from "../../apps/api/server.js";
import { hashAdminPassword } from "../../src/admin/auth.js";
import { defaultConfig, getRootDir, getWorkspaceDir, saveConfig } from "../../src/config.js";
import { beginFirstRunBootstrap, FIRST_RUN_JOURNAL } from "../../tooling/runtime/first-run-state.mjs";
import { initializeWorkspace } from "../../tooling/workspace/init-workspace.mjs";

const root = getRootDir();
const workspace = getWorkspaceDir();
const providerRequests: string[] = [];
const providerServer = http.createServer((request, response) => {
  request.resume();
  providerRequests.push(request.url ?? "");
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: "first-run-completion",
    object: "chat.completion",
    created: 1,
    model: "first-run-model",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "欢迎回来。" },
      finish_reason: "stop"
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }));
});
await new Promise<void>((resolve, reject) => {
  providerServer.once("error", reject);
  providerServer.listen(0, "127.0.0.1", resolve);
});
const providerAddress = providerServer.address();
if (!providerAddress || typeof providerAddress === "string") throw new Error("Provider fixture failed to listen.");

await initializeWorkspace({ root, workspace });
await beginFirstRunBootstrap(workspace, new Date("2026-07-14T00:00:00.000Z"));
const config = defaultConfig();
config.bot.adminQq = "171419991";
config.providers.items.push({
  id: "first-run-provider",
  label: "首次运行 Provider",
  kind: "openai-compatible",
  enabled: true,
  model: "first-run-model",
  imageModel: "first-run-image-model",
  baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
  apiKeyEnv: "FIRST_RUN_PROVIDER_KEY",
  envFile: "workspace/secrets/runtime.env",
  temperature: 0.2,
  maxOutputTokens: 200,
  modelSource: "custom",
  multimodal: "disabled"
});
await saveConfig(config);
await writeAdminCredentials(workspace);
const reconciled: string[] = [];
let onebot: WebSocket | undefined;
const built = await buildApp({
  config,
  initializeRuntime: true,
  onebotListener: { host: "127.0.0.1", port: 0 },
  runtimeProbeClient: false,
  accountRuntimeReconciler: {
    reconcile: async (accountId) => {
      reconciled.push(accountId);
      return {
        schemaVersion: 1,
        accountId,
        desiredState: "running",
        observedState: "running",
        reconcileRequired: false,
        lastError: null,
        updatedAt: "2026-07-14T00:01:00.000Z"
      };
    }
  }
});

try {
  const session = await built.app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { host: "127.0.0.1" },
    payload: { username: "admin", password: "correct-horse-battery-staple" }
  });
  const cookie = String(session.headers["set-cookie"]).split(";", 1)[0];
  const csrf = session.json().csrfToken;
  const readHeaders = { cookie, host: "127.0.0.1" };
  const writeHeaders = {
    ...readHeaders,
    origin: "http://127.0.0.1",
    "x-sunabot-csrf": csrf
  };
  const envelope = await built.app.inject({ method: "GET", url: "/api/config", headers: readHeaders });
  const providers = envelope.json().config.providers;
  const selected = await built.app.inject({
    method: "PATCH",
    url: "/api/config/providers",
    headers: writeHeaders,
    payload: {
      revision: envelope.json().revision,
      value: { ...providers, defaultProviderId: "first-run-provider" }
    }
  });
  const createdAgent = await built.app.inject({
    method: "POST",
    url: "/api/agents",
    headers: writeHeaders,
    payload: { id: "arona", name: "阿罗娜" }
  });
  const createdAccount = await built.app.inject({
    method: "POST",
    url: "/api/agents/arona/accounts",
    headers: writeHeaders,
    payload: { label: "阿罗娜主账号" }
  });
  const account = createdAccount.json();
  const login = await built.app.inject({
    method: "GET",
    url: `/api/agents/arona/accounts/${account.id}/login/status`,
    headers: readHeaders
  });

  const onebotAddress = await built.startOneBotListener();
  const sentPrivateMessages: unknown[] = [];
  onebot = new WebSocket(
    `ws://127.0.0.1:${onebotAddress.port}${config.onebot.reverseWsPath}`
      + `?access_token=first-run-onebot-token&account_id=${encodeURIComponent(account.id)}`,
    { headers: { "x-self-id": "246801357" } }
  );
  onebot.on("message", (data) => {
    const request = JSON.parse(data.toString());
    if (request.action === "send_private_msg") sentPrivateMessages.push(request.params);
    onebot?.send(JSON.stringify({
      status: "ok",
      retcode: 0,
      echo: request.echo,
      data: request.action === "get_login_info"
        ? { user_id: 246801357, nickname: "first-run" }
        : { message_id: 9001 }
    }));
  });
  await new Promise<void>((resolve, reject) => {
    onebot?.once("open", resolve);
    onebot?.once("error", reject);
  });
  onebot.send(JSON.stringify({
    time: Math.floor(Date.now() / 1_000),
    self_id: 246801357,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 7001,
    user_id: 171419991,
    raw_message: "你好",
    message: [{ type: "text", data: { text: "你好" } }],
    sender: { user_id: 171419991, nickname: "猫老师" }
  }));
  await waitFor(() => sentPrivateMessages.length > 0 && providerRequests.length > 0, 15_000);
  const online = await built.app.inject({
    method: "GET",
    url: `/api/agents/arona/accounts/${account.id}/login/status`,
    headers: readHeaders
  });
  const journalCompleted = await fs.access(path.join(workspace, FIRST_RUN_JOURNAL))
    .then(() => false, () => true);
  console.log(`SUNABOT_FIRST_RUN_E2E=${JSON.stringify({
    adminAuthenticated: session.json().authenticated === true,
    providerId: selected.json().config?.providers?.defaultProviderId,
    providerRequests: providerRequests.length,
    agentId: createdAgent.json().id,
    accountRuntime: reconciled.includes(account.id) && account.observedState === "running" ? "running" : "missing",
    qqOnlineBeforeScan: login.json().online === true,
    qqOnlineAfterConnect: online.json().online === true,
    firstReplyDelivered: sentPrivateMessages.length,
    journalCompleted
  })}`);
} finally {
  onebot?.close();
  await built.app.close();
  await new Promise<void>((resolve, reject) => providerServer.close((error) => error ? reject(error) : resolve()));
}

async function waitFor(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("First-run reply timed out.");
}

async function writeAdminCredentials(workspaceRoot: string) {
  const now = "2026-07-14T00:00:00.000Z";
  await fs.writeFile(path.join(workspaceRoot, "secrets/admin-credentials.json"), JSON.stringify({
    version: 1,
    username: "admin",
    password: await hashAdminPassword("correct-horse-battery-staple"),
    createdAt: now,
    updatedAt: now
  }));
}
