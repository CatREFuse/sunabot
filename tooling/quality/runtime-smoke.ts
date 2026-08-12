#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  buildNapCatSmokeConfig,
  configureNapCatForSmoke,
  initializeSmokeWorkspace,
  loadSmokeContext
} from "./runtime-smoke/context.js";
import { assertPortFree, runOneBotSmoke, validateActionResponse } from "./runtime-smoke/onebot.js";
import { maskQq, scrubSecrets } from "./runtime-smoke/shared.js";

export {
  buildNapCatSmokeConfig,
  loadSmokeContext,
  maskQq,
  scrubSecrets,
  validateActionResponse
};

export async function main(argv = process.argv.slice(2)) {
  const [command = "preflight", ...argumentsList] = argv;
  const flags = new Set(argumentsList);

  if (command === "init") {
    requireFlag(flags, "--confirm-isolated-workspace");
    const workspace = await initializeSmokeWorkspace();
    console.log(`隔离冒烟标记已创建：${workspace}`);
    return;
  }

  if (command === "configure-onebot") {
    requireFlag(flags, "--confirm-isolated-workspace");
    const context = await loadSmokeContext({ requireOneBotCredential: true });
    const files = await configureNapCatForSmoke(context);
    console.log(`测试 NapCat OneBot 配置已写入 ${files.length} 个文件；Token 已隐藏。`);
    return;
  }

  if (command === "preflight" || command === "dry-run") {
    const context = await fullSmokeContext();
    await assertPortFree("127.0.0.1", context.onebotPort);
    printPreflight(context);
    return;
  }

  if (command === "onebot") {
    requireExecutionGate(flags, "--execute-onebot", "SUNABOT_SMOKE_ALLOW_ONEBOT_SEND");
    requireDedicatedTestQqAttestation();
    const context = await loadSmokeContext({ requireOneBotCredential: true, requireNapCatConfig: true });
    printOneBotResult(await runOneBotSmoke(context), context.adminQq);
    return;
  }

  throw new Error("未知命令。可用命令：init、configure-onebot、preflight、onebot。");
}

function fullSmokeContext() {
  return loadSmokeContext({
    requireProviderCredential: true,
    requireOneBotCredential: true,
    requireNapCatConfig: true
  });
}

function printPreflight(context: Awaited<ReturnType<typeof loadSmokeContext>>) {
  console.log("隔离运行时冒烟预检通过（未发起网络请求，未发送 QQ 消息）。");
  console.log(`workspace: ${context.workspace}`);
  console.log(`provider: ${context.provider.label ?? context.provider.id} / ${context.provider.kind} / ${context.provider.model}`);
  console.log(`provider credential: configured (${context.provider.apiKeyEnv})`);
  console.log(`OneBot: ${context.onebotUrl} / token configured`);
  console.log(`test QQ: ${maskQq(context.napcatAccount)} / admin QQ: ${maskQq(context.adminQq)}`);
}

function printOneBotResult(result: Awaited<ReturnType<typeof runOneBotSmoke>>, adminQq: string) {
  console.log(
    `OneBot 冒烟通过：测试账号 ${maskQq(result.selfId)} 已向管理员 ${maskQq(adminQq)} 发送标记消息，` +
    `message_id=${result.messageId}。`
  );
}

function requireFlag(flags: Set<string>, flag: string) {
  if (!flags.has(flag)) throw new Error(`该命令需要显式参数 ${flag}。`);
}

function requireExecutionGate(flags: Set<string>, flag: string, environmentName: string) {
  requireFlag(flags, flag);
  if (process.env[environmentName] !== "1") throw new Error(`真实执行还需要临时设置 ${environmentName}=1。`);
}

function requireDedicatedTestQqAttestation() {
  if (process.env.SUNABOT_SMOKE_DEDICATED_QQ !== "1") {
    throw new Error("OneBot 真实发送要求 SUNABOT_SMOKE_DEDICATED_QQ=1，确认使用不会挤掉生产登录的专用测试 QQ。");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(`运行时冒烟失败：${scrubSecrets(error)}`);
    process.exitCode = 1;
  });
}
