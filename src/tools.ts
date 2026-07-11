export interface SunaTool {
  name: string;
  title: string;
  description: string;
  enabled: boolean;
}

export const TOOL_CALL_TIMEOUT_MS = 300_000;

export const defaultTools: SunaTool[] = [
  {
    name: "system.time",
    title: "时间",
    description: "读取当前时间和时区。",
    enabled: true
  },
  {
    name: "memory_recall",
    title: "记忆召回",
    description: "从 Plana 记忆中召回相关内容。",
    enabled: true
  },
  {
    name: "onebot.send_message",
    title: "发送消息",
    description: "向 OneBot 私聊或群聊发送消息。",
    enabled: true
  },
  {
    name: "websearch",
    title: "网页搜索",
    description: "搜索网页并返回结果。",
    enabled: true
  },
  {
    name: "generate_img",
    title: "生图",
    description: "生成图片并保存结果。",
    enabled: true
  },
  {
    name: "selfie",
    title: "自拍",
    description: "生成 Bot 自己的形象图。",
    enabled: true
  },
  {
    name: "bash.run",
    title: "Bash",
    description: "在 Agent workspace 内执行 bash 命令。",
    enabled: true
  },
  {
    name: "provider.test",
    title: "模型检查",
    description: "检查当前 provider 的连接状态。",
    enabled: true
  }
];
