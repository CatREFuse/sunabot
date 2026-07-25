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

export const CURRENT_RELEASE_VERSION = "0.1.2";

export const RELEASE_CATALOG: ReleaseCatalog = {
  schemaVersion: 1,
  currentVersion: CURRENT_RELEASE_VERSION,
  releases: [
    {
      version: "0.1.2",
      releasedAt: "2026-07-25",
      title: "双工作区投影",
      summary: "Native 与 Docker 工作区保持独立，并提供完整只读寻址投影。",
      groups: [
        {
          title: "工作区",
          items: [
            "自拍、表情、Skills 与知识库直接位于 Native workbench。",
            "Docker workbench 通过 native-workbench 只读访问同一份资源。",
            "Native Bash 可通过 SUNABOT_DOCKER_WORKBENCH 寻址 Docker 工作区。"
          ]
        },
        {
          title: "升级",
          items: [
            "既有 Agent 资源由停服迁移脚本统一搬入 Native workbench。",
            "迁移保留逐 Agent 备份、校验和与冲突保护回滚。",
            "系统提示词与两个 index.md 会同步说明实际寻址路径。"
          ]
        }
      ]
    },
    {
      version: "0.1.1",
      releasedAt: "2026-07-25",
      title: "Bot 工作台资源",
      summary: "Bot 工作台、资源管理入口与 JSONL 清单完成统一升级。",
      groups: [
        {
          title: "工作台",
          items: [
            "Bot 可在授权范围内通过 Bash 访问并操作自己的 workbench。",
            "工作目录、Skills、MCP、自拍、表情和知识库提供固定管理入口。",
            "系统提示词会先引导 Bot 查询目录入口，再使用对应资源。"
          ]
        },
        {
          title: "资源管理",
          items: [
            "自拍参考图改用同目录 references.jsonl 清单。",
            "表情图片改用同目录 emojis.jsonl 清单，保留多版本记录。",
            "知识库提供可重建的 index.json，管理台修改仍会同步到资源目录。"
          ]
        },
        {
          title: "升级与恢复",
          items: [
            "提供 0.1.0 到 0.1.1 的预检、离线备份、迁移和重启脚本。",
            "自拍清单迁移支持内容校验、冲突拒绝和独立回滚。",
            "升级完成后自动执行运行状态与配置检查。"
          ]
        }
      ]
    },
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
