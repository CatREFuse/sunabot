import type { SettingsSectionKey } from "../../types";

export interface SettingsSectionDefinition {
  id: SettingsSectionKey;
  label: string;
  group: string;
  description: string;
  scope: "agent" | "system";
}

export const settingsCatalog: readonly SettingsSectionDefinition[] = [
  { id: "persona", label: "Agent 身份", group: "身份与回复", description: "头像、Agent 标识与管理员身份", scope: "agent" },
  { id: "bot", label: "回复行为", group: "身份与回复", description: "回复模型、读图、时机、范围与唤醒", scope: "agent" },
  { id: "tone", label: "语气处理", group: "身份与回复", description: "语气改写、分段发送与独立模型", scope: "agent" },
  { id: "memory", label: "记忆处理", group: "上下文与编排", description: "压缩模型、容量、Dream 抽样与提示词", scope: "agent" },
  { id: "orchestrator", label: "群聊编排", group: "上下文与编排", description: "Thread 拆分与主动回复", scope: "agent" },
  { id: "tools", label: "Agent 工具", group: "能力与权限", description: "工具目录与运行参数", scope: "agent" },
  { id: "bash", label: "命令执行", group: "能力与权限", description: "审批 Agent 与会话执行边界", scope: "agent" },
  { id: "providers", label: "模型服务", group: "模型与回复", description: "Provider、连接、模型与生成参数", scope: "system" },
  { id: "normalReply", label: "回复重试", group: "模型与回复", description: "全部 Agent 共用的回复失败重试", scope: "system" },
  { id: "broadcastStorm", label: "广播风暴", group: "安全与连接", description: "广播风暴检测与静默策略", scope: "system" },
  { id: "security", label: "账户安全", group: "安全与连接", description: "管理员密码与会话轮换", scope: "system" },
  { id: "onebot", label: "连接与通知", group: "安全与连接", description: "Bark 通知与 OneBot 连接", scope: "system" }
];

export function settingsForScope(scope: "agent" | "system") {
  return settingsCatalog.filter((section) => section.scope === scope);
}
