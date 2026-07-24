import type { ThemePreference } from "../../composables/useTheme";

export interface NavigationItem {
  to: string;
  label: string;
  mobileLabel: string;
  description: string;
  icon: string;
  mobilePlacement: "primary" | "more";
  mobileOrder: number;
}

export interface NavigationSection {
  label: string;
  items: readonly NavigationItem[];
}

export const navigationSections: readonly NavigationSection[] = [
  {
    label: "Agent",
    items: [
      { to: "/agent-settings", label: "Agent 设置", mobileLabel: "Agent", description: "身份、回复与工具", icon: "bx-slider-alt", mobilePlacement: "primary", mobileOrder: 4 },
      { to: "/overview", label: "状态", mobileLabel: "状态", description: "运行与用量", icon: "bx-pulse", mobilePlacement: "primary", mobileOrder: 0 },
      { to: "/web-chat", label: "Web Chat", mobileLabel: "Web Chat", description: "与当前 Agent 对话", icon: "bx-chat", mobilePlacement: "primary", mobileOrder: 1 },
      { to: "/conversations", label: "会话", mobileLabel: "会话", description: "查看消息记录", icon: "bx-message-square-dots", mobilePlacement: "primary", mobileOrder: 2 },
      { to: "/scheduled-tasks", label: "定时任务", mobileLabel: "定时任务", description: "管理主动回调", icon: "bx-calendar-event", mobilePlacement: "more", mobileOrder: 5 },
      { to: "/director", label: "导演系统", mobileLabel: "导演系统", description: "决策与计划任务", icon: "bx-movie-play", mobilePlacement: "more", mobileOrder: 6 },
      { to: "/agent-prompts", label: "Agent 提示词", mobileLabel: "提示词", description: "编辑 Agent 提示词", icon: "bx-bot", mobilePlacement: "primary", mobileOrder: 3 },
      { to: "/memory", label: "记忆", mobileLabel: "记忆", description: "检索与维护记忆", icon: "bx-brain", mobilePlacement: "more", mobileOrder: 0 },
      { to: "/knowledge", label: "知识库", mobileLabel: "知识库", description: "资料与检索", icon: "bx-library", mobilePlacement: "more", mobileOrder: 1 },
      { to: "/images", label: "图像", mobileLabel: "图像", description: "查看图像历史", icon: "bx-image", mobilePlacement: "more", mobileOrder: 2 },
      { to: "/voice", label: "语音", mobileLabel: "语音", description: "语言与参考音频", icon: "bx-user-voice", mobilePlacement: "more", mobileOrder: 3 },
      { to: "/emojis", label: "表情", mobileLabel: "表情", description: "管理发送表情", icon: "bx-happy-alt", mobilePlacement: "more", mobileOrder: 4 },
      { to: "/logs", label: "日志", mobileLabel: "日志", description: "活动终端与请求日志", icon: "bx-terminal", mobilePlacement: "more", mobileOrder: 5 },
      { to: "/extensions", label: "扩展", mobileLabel: "扩展", description: "Skill 与 MCP", icon: "bx-extension", mobilePlacement: "more", mobileOrder: 7 }
    ]
  },
  {
    label: "公共系统",
    items: [
      { to: "/settings", label: "系统设置", mobileLabel: "系统设置", description: "模型、账户与连接", icon: "bx-cog", mobilePlacement: "more", mobileOrder: 0 },
      { to: "/config-doctor", label: "配置医生", mobileLabel: "配置医生", description: "检查并修复配置", icon: "bx-first-aid", mobilePlacement: "more", mobileOrder: 1 },
      { to: "/system-prompts", label: "系统提示词", mobileLabel: "系统提示词", description: "所有 Agent 的默认提示词", icon: "bx-file", mobilePlacement: "more", mobileOrder: 2 },
      { to: "/releases", label: "版本更新", mobileLabel: "版本更新", description: "当前版本与更新日志", icon: "bx-package", mobilePlacement: "more", mobileOrder: 3 }
    ]
  }
];

export const mobilePrimaryItems = navigationSections
  .flatMap((section) => section.items)
  .filter((item) => item.mobilePlacement === "primary")
  .slice()
  .sort((left, right) => left.mobileOrder - right.mobileOrder);

export const mobileMoreSections = navigationSections
  .map((section) => ({
    label: section.label,
    items: section.items
      .filter((item) => item.mobilePlacement === "more")
      .slice()
      .sort((left, right) => left.mobileOrder - right.mobileOrder)
  }))
  .filter((section) => section.items.length > 0);

export const themeItems: ReadonlyArray<{ id: ThemePreference; label: string; icon: string }> = [
  { id: "light", label: "浅色", icon: "bx-sun" },
  { id: "dark", label: "深色", icon: "bx-moon" },
  { id: "system", label: "系统", icon: "bx-desktop" }
];
