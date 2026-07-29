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

export const CURRENT_RELEASE_VERSION = "0.2.0";

export const RELEASE_CATALOG: ReleaseCatalog = {
  schemaVersion: 1,
  currentVersion: CURRENT_RELEASE_VERSION,
  releases: [
    {
      version: "0.2.0",
      releasedAt: "2026-07-29",
      title: "跨平台网页渲染",
      summary: "动态网页渲染按宿主平台进入独立隔离环境，并复用已经安装的 Chromium。",
      groups: [
        {
          title: "动态渲染",
          items: [
            "macOS Native Core 使用独立 Docker Renderer，Linux 与 WSL Native Core 使用 Bubblewrap Renderer。",
            "Docker Core 继续通过 Compose 私有网络访问独立 Renderer。",
            "Renderer 不可用时保留静态 WebFetch，并明确报告动态能力降级。"
          ]
        },
        {
          title: "隔离与鉴权",
          items: [
            "宿主 Renderer 只监听回环地址，并使用每次启动重新生成的 bearer token。",
            "Renderer 不挂载 Agent workspace、数据库、Provider、Codex 或 OneBot 凭据。",
            "doctor 会验证 Renderer 运行环境与 Chromium sandbox，缺失时不会静默降级。"
          ]
        },
        {
          title: "启动与升级",
          items: [
            "Chromium 在首次依赖同步或 Playwright 升级时安装，普通启动和重启复用现有镜像或浏览器。",
            "启动器监管 Native Renderer 的进程组、健康、日志、退出与残留回收。",
            "0.1.4 可通过版本专用脚本创建恢复点并完成重启、状态和运行检查。"
          ]
        }
      ]
    },
    {
      version: "0.1.4",
      releasedAt: "2026-07-28",
      title: "图片任务可靠性",
      summary: "异步图片任务会在派发时冻结参考图，并隔离群聊编排器内部记录。",
      groups: [
        {
          title: "图片参考",
          items: [
            "当前、引用和历史图片会在任务派发时下载并写入内容寻址媒体归档。",
            "图片下载最多重试三次，队列只保存不可变摘要和归档引用。",
            "Provider 请求前核对参考图数量，必需图片解析失败会返回明确错误。"
          ]
        },
        {
          title: "群聊稳定性",
          items: [
            "群聊编排器内部结果不会进入主回复模型的会话上下文。",
            "thread 分类器等待时间延长到 20 秒。"
          ]
        },
        {
          title: "升级",
          items: [
            "0.1.3 可通过版本专用脚本创建恢复点并完成重启、状态和运行检查。",
            "本次升级不修改 SQLite schema、系统提示词或资源目录。"
          ]
        }
      ]
    },
    {
      version: "0.1.3",
      releasedAt: "2026-07-25",
      title: "聊天媒体导出",
      summary: "Agent 可以把本轮图片和文件安全保存到自己的 Workbench，并由管理员直接导入表情库。",
      groups: [
        {
          title: "聊天媒体",
          items: [
            "当前消息和明确引用消息会提供可导出的图片与文件句柄。",
            "导出结果使用 SHA-256 文件名并返回类型、尺寸和字节信息。",
            "Native 与 Docker Bash 可在各自权限内继续处理已导出的文件。"
          ]
        },
        {
          title: "表情导入",
          items: [
            "当前 Agent 的管理员可在 QQ 私聊或群聊中把本轮图片直接导入同一表情库。",
            "导入统一执行图片校验、规范化、内容去重和 JSONL 原子更新。",
            "系统提示词会说明句柄、工作区路径和表情写入边界。"
          ]
        },
        {
          title: "安全与升级",
          items: [
            "工具不接受任意 URL、宿主路径、目标路径或 Agent ID。",
            "跨会话、跨 Agent、伪造句柄、类型伪装和超限文件会失败关闭。",
            "0.1.2 可通过版本专用脚本创建恢复点并完成提示词迁移与重启检查。"
          ]
        }
      ]
    },
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
