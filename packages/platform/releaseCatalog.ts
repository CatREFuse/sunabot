export interface ReleaseChangeGroup {
  title: string;
  items: readonly string[];
}

export interface ReleaseRecord {
  version: string;
  releasedAt: string;
  title: string;
  summary: string;
  groups: readonly ReleaseChangeGroup[];
}

export interface ReleaseCatalog {
  schemaVersion: 1;
  currentVersion: string;
  releases: readonly ReleaseRecord[];
}

export const CURRENT_RELEASE_VERSION = "0.1.0";

export const RELEASE_CATALOG: ReleaseCatalog = {
  schemaVersion: 1,
  currentVersion: CURRENT_RELEASE_VERSION,
  releases: [
    {
      version: "0.1.0",
      releasedAt: "2026-07-22",
      title: "首次发布",
      summary: "多 Agent、消息投递、记忆与管理台能力完成首个可用版本整合。",
      groups: [
        {
          title: "核心能力",
          items: [
            "支持多 Agent 与多 QQ 账号独立管理。",
            "私聊、群聊、定时任务和 Web Chat 使用统一会话队列。",
            "支持记忆、知识库、图像、表情和在线语音。"
          ]
        },
        {
          title: "稳定性",
          items: [
            "消息进入持久投递队列，连接恢复后可继续发送。",
            "模型过载采用有界重试，请求日志保留原始错误。",
            "加强运行检查、配置修复和工具权限边界。"
          ]
        },
        {
          title: "管理台",
          items: [
            "集中管理 Agent、账号、会话、提示词、设置、日志和扩展。",
            "提示词编辑支持变量补全、搜索、折叠与冲突处理。",
            "新增当前版本与更新日志页面。"
          ]
        }
      ]
    }
  ]
};
