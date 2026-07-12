const labels: Record<string, string> = {
  "server.host": "Host",
  "server.port": "Port",
  "persona.agentWorkspace": "工作目录",
  "persona.memoryLimit": "记忆上限",
  "providers.defaultProviderId": "默认 Provider",
  "providers.items": "Provider 列表",
  "providers.items.*.id": "ID",
  "providers.items.*.label": "名称",
  "providers.items.*.kind": "协议",
  "providers.items.*.enabled": "启用 Provider",
  "providers.items.*.model": "模型",
  "providers.items.*.reasoningEffort": "推理强度",
  "providers.items.*.imageModel": "图像模型",
  "providers.items.*.baseUrl": "Base URL",
  "providers.items.*.apiKeyEnv": "API Key Env",
  "providers.items.*.envFile": "Env File",
  "providers.items.*.temperature": "随机性（Temperature）",
  "providers.items.*.maxOutputTokens": "最大输出 Token",
  "bot.adminQq": "管理员 QQ",
  "bot.adminName": "管理员称呼",
  "bot.contextMessageLimit": "上下文消息数",
  "bot.quoteGroupReplies": "引用群聊消息",
  "memory.memoryModel": "模型",
  "memory.reasoningEffort": "推理强度",
  "memory.messageThreshold": "压缩阈值",
  "memory.workingMemoryMaxEntries": "工作记忆上限",
  "memory.workMemoryCompressInPrompt": "写入压缩",
  "memory.workMemoryCompressOutPrompt": "归档压缩",
  "memory.userProfilePrompt": "用户画像",
  "orchestrator.enabled": "编排器",
  "orchestrator.userGroupchatOrchestratorModel": "模型",
  "orchestrator.reasoningEffort": "推理强度",
  "orchestrator.messageThreshold": "消息阈值",
  "orchestrator.recentMessageWindowMs": "最近消息窗口 / ms",
  "orchestrator.promptFile": "提示词文件",
  "tools.websearch.provider": "网页搜索",
  "tools.websearch.maxResults": "最大结果数",
  "tools.websearch.tavilyApiKey": "Tavily API Key",
  "tools.websearch.tavilyApiKeys": "Tavily Key 池",
  "tools.websearch.removeTavilyApiKeyIndexes": "Tavily Key 池",
  "tools.websearch.tavilyApiKeyEnv": "Tavily Key 环境变量",
  "tools.websearch.clearTavilyApiKey": "清除已保存的 Key",
  "tools.codex.enabled": "启用 Codex",
  "tools.codex.model": "模型",
  "tools.codex.codexExecutable": "可执行文件",
  "tools.codex.timeoutMs": "任务超时（毫秒）",
  "tools.codex.maxConcurrency": "最大并发数",
  "tools.generateImg.provider": "图像生成",
  "tools.generateImg.size": "默认尺寸",
  "tools.generateImg.resolution": "默认清晰度",
  "tools.generateImg.quality": "默认质量",
  "bash.enabled": "启用 Bash",
  "bash.allowGroup": "允许群聊",
  "bash.adminOnly": "仅管理员",
  "bash.workspaceOnly": "仅 Agent Workspace",
  "bash.blockedKeywords": "阻止关键字",
  "onebot.reverseWsPath": "反向 WebSocket 路径",
  "onebot.accessTokenEnv": "Access Token 环境变量",
  "onebot.autoReplyPrivate": "启用私聊",
  "onebot.autoReplyUserGroup": "启用",
  "onebot.autoReplyBotGroup": "启用 Bot 群聊",
  "onebot.mentionNames": "名称",
  "onebot.commandPrefixes": "命令前缀"
};

const interactiveSelector = "input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])";

export function focusConfigField(root: HTMLElement, field: string) {
  const direct = Array.from(root.querySelectorAll<HTMLElement>("[data-config-field]"))
    .find((element) => element.dataset.configField === field);
  const directTarget = asTarget(direct);
  if (directTarget) return focus(directTarget);

  const normalized = field.replace(/^providers\.items\.\d+\./, "providers.items.*.");
  const label = labels[normalized];
  if (!label) return false;

  const fieldLabel = Array.from(root.querySelectorAll<HTMLElement>(".field-label"))
    .find((element) => element.textContent?.trim() === label);
  const labelledTarget = asTarget(fieldLabel?.closest("label") ?? fieldLabel?.parentElement);
  if (labelledTarget) return focus(labelledTarget);

  const ariaTarget = Array.from(root.querySelectorAll<HTMLElement>(interactiveSelector))
    .find((element) => element.getAttribute("aria-label") === label);
  if (ariaTarget) return focus(ariaTarget);

  const containingLabel = Array.from(root.querySelectorAll<HTMLLabelElement>("label"))
    .find((element) => element.textContent?.trim().startsWith(label));
  const target = asTarget(containingLabel);
  return target ? focus(target) : false;
}

function asTarget(container: HTMLElement | null | undefined) {
  if (!container) return null;
  if (container.matches(interactiveSelector)) return container;
  return container.querySelector<HTMLElement>(interactiveSelector);
}

function focus(target: HTMLElement) {
  target.focus({ preventScroll: true });
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}
