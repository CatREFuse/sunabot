# 产品范围与运行结构

[返回当前系统规范索引](./index.md)

## 1. 产品范围

sunabot 是面向个人自托管场景的 QQ 多 Agent 服务。系统通过 OneBot v11 反向 WebSocket 接入多个独立 NapCat 账号，每个 QQ 账号归属一个 Agent；各 Agent 以独立人格处理私聊和用户群聊，支持上下文回复、群聊编排、长期记忆、用户画像、文件读取、联网搜索、静态与动态网页抓取、图像生成、自拍、在线语音、Codex 异步任务、本地 Web Chat 和管理台。同一 QQ 在新 Agent 账号中完成登录时，登录流程退出旧账号并转移唯一归属，不复制或迁移旧 Agent 的会话、记忆、队列和历史数据。

当前目标是单实例、单管理员、多 Agent，每个 Agent 可接入多个 QQ。多租户、完整 OneBot v12 和公网多用户管理台不属于当前版本。Provider 与模型目录、正常回复重试、共用开关和公共系统提示词由所有 Agent 共享；回复模型、读图模型、Bot 行为、人格提示词、自拍提示词改写、可选系统提示词覆盖、语音、记忆、会话、图片历史、异步队列、Agent workspace 和 QQ 账号按 Agent 隔离。

每个 Agent 只有一个 canonical Workbench：

```text
workspace/business/agents/<agentId>/workbench/
```

自拍、表情、知识库、Skill 资源、MCP 目录、聊天媒体导出和工具产物都从该目录寻址。`docker-workbench/` 只允许作为 0.2.0 到 0.3.0 的停服迁移输入；当前运行时、管理 API、管理台和新 Agent 不创建、读取或展示该目录。

定时任务保存名称、启用状态、任务上下文、cron 或单次触发计划，以及一个或多个既有 QQ 会话目标和各目标的结构化 @ 对象。每次到期冻结一份 `role=callback` 输入，再分别进入每个目标会话的 Session 队列；各目标复用正常私聊或群聊的最终提示词、历史、记忆、工具、deferred handoff 与 durable outbox。目标账号、会话和 @ 对象按任务快照执行，不能因管理台当前选择或后续编辑漂移。

每个 Agent 具有独立的每日 Dream 管线。系统按宿主 IANA 时区在每天 04:00 读取当前工作记忆、长期记忆只读索引、实际对话、活动任务、已提交日程与人格材料，通过一次模型请求生成工作记忆压缩、长期记忆添加和梦境描述。Dream 不删除长期记忆，不产生 QQ 消息、Session 事件或 outbox，也不跨 Agent 读取数据。

## 2. 运行结构

```text
宿主机 ./sunabot.sh
├── Sunabot Core（Native）
│   ├── 127.0.0.1:8787 管理 API 与 Vue 管理台
│   ├── :8788 OneBot v11 反向 WebSocket（强制 token）
│   ├── AgentRuntimeManager
│   ├── Native Bash / MCP / Skill Script
│   └── Agent 注册主库、各 Agent 业务库、队列库与 canonical Workbench
├── WebFetch
│   ├── Core 内 Node + Defuddle 静态抓取
│   └── Linux/WSL Native Lightpanda Renderer（127.0.0.1:8790，Bubblewrap）
└── NapCat Docker × QQ 账号
    ├── 每个账号独立容器、配置与 QQ 登录态
    ├── 127.0.0.1:6099 起的独立 NapCat WebUI 端口
    └── 携带 account_id 的 OneBot 事件、action 与 base64 媒体
```

Core、Bash、MCP、Skill Script 与 WebFetch 只以 Native 形态运行。NapCat 是唯一 Docker 组件；每个账号使用独立容器，不能并入 Core 或与 Core 共享业务文件系统。根目录 `./sunabot.sh` 统一负责初始化、启动顺序、健康检查、停止、日志和灵魂文件 CLI。`SUNABOT_CORE_MODE` 与 `--core` 已退役，传入时明确拒绝。

管理台只发布到宿主回环 `127.0.0.1:8787`。OneBot 使用专用 `8788` 端口并强制 access token：Linux 与 WSL 内置 Docker Engine 绑定当前运行网络在 Native 命名空间内的 bridge gateway；WSL Docker Desktop 的 bridge gateway 位于独立 `docker-desktop` 发行版时，Core 只绑定 `127.0.0.1`，NapCat 通过 Docker Desktop 的 `host.docker.internal` 主机转发连接。启动器必须从 NapCat 镜像执行 `/healthz` 探针并使用探针确认的地址写入配置；gateway 不属于本机且安全回环转发不可达时回滚启动，不能改绑 `0.0.0.0`、WSL `eth0` 或局域网地址。每个 NapCat WebUI 只发布到宿主回环，首个账号默认使用 `127.0.0.1:6099`。跨组件媒体使用 OneBot `base64://`，不传递宿主、Core 或 NapCat 的共享绝对路径。

## 3. 启动、状态与首次运行

`up`、`start` 与 `restart` 进入同一清空后启动流程，只停止能通过命令签名、workspace 身份、进程启动身份或 Docker labels 证明属于当前部署的对象。随后启动 Native Core、Linux/WSL Lightpanda Renderer、注册表中全部已启用 NapCat 和 account runtime daemon。未知身份对象、端口占用、迁移未完成或运行依赖缺失时失败关闭。

`status`、`doctor`、管理 API 和平台入口共用只读运行探针，分别报告 API、OneBot、每个 QQ、Provider、Codex、Native Bash、MCP、Skill Script、Bubblewrap、WebFetch Renderer、workspace 和迁移状态。QQ 临时离线只降低 readiness，不把 Core 判为死亡。macOS 的动态 WebFetch capability 固定为 unavailable；静态 WebFetch 保持可用。

首次 `up` 使用带 HMAC 的持久 journal，并在当前终端进入 Landing：设置管理员名称、管理员密码和密码确认。密码输入不回显，长度至少 12 个字符；凭据通过同目录临时文件写入，完成文件 `fsync`、原子替换和父目录 `fsync` 后才返回。Core 构建阶段只复验持久边界与凭据可读性，不能提交完成状态；launcher 必须等待 AdminAuth 成功读取凭据、管理 API 与 OneBot 已监听、account runtime daemon 和全部应运行 NapCat 通过完整探针并连续稳定后，再次读取并校验凭据，把完成提交作为启动流程最后一个可失败步骤。此前任一步失败都保留 journal，可继续启动或通过 `rollback-first-run` 受控回滚，未知文件保留。workspace 完整父目录链在 marker、配置、凭据、SQLite、注册表或运行目录写入前逐级拒绝用户符号链接。

发行包的 `help|status|doctor|logs|down|up|start|restart` 不安装应用依赖。`bootstrap` 只验证随包运行时、生产依赖、构建产物和组件完整性。发行包内供进程管理器使用的 Core 入口同样只接受包内 Node 与绝对 Bubblewrap，拒绝宿主可执行文件覆盖与 `/usr/bin/bwrap` 回退，并在执行 Core 前验证完整 release manifest。源码形态可以按锁文件显式准备依赖。

## 4. Native 工具边界

Native Bash 复用当前 Agent 的 canonical Workbench。macOS 只向管理员 QQ 私聊和已认证管理员 Web Chat 开放宿主 `/bin/bash`，每条命令必须通过独立对抗审批；其他会话没有 Bash capability。Linux/WSL 使用随包 Bubblewrap 与资源限制运行经过审批的命令，不能回退到未隔离宿主 shell。审批票据绑定 Agent、账号、transport、完整会话、用户、命令摘要和当前配置 revision。

MCP 与 Skill Script 由 Native Core 管理。Linux/WSL 的 stdio 进程和脚本执行使用 Bubblewrap、最小环境与受控 Workbench/扩展投影；秘密只从当前 Agent 的凭据边界按声明键注入。launcher 在检查真实 namespace 后固定 `SUNABOT_BWRAP_EXECUTABLE`：发行形态只允许包内 `runtime/bubblewrap/bwrap`，并向 Native Bash、stdio MCP、Skill Script 与 WebFetch Renderer 注入同一路径；`.env`、会话参数和工具参数不能覆盖，注入缺失时发行进程失败关闭。源码形态可明确使用 `/usr/bin/bwrap`。运行时下载依赖、Docker launcher 和 Docker socket 均不属于当前合同。扩展初始化失败只关闭对应可选能力，不能切换到 Docker 或其他后端。

Codex CLI `0.139.0` 是固定生产依赖。发行包从生产 `node_modules` 提供 CLI；授权保存在当前 workspace 的 `secrets/codex/auth.json`。CLI 缺失或版本不匹配时 doctor 报告明确错误，授权缺失时 Core 保持可启动以完成设备登录，但 Codex 工具不可调用。

## 5. WebFetch

静态 WebFetch 在 Core 内使用 Node 抓取和 Defuddle 提取正文。正文不足时，Linux/WSL 调用由 launcher 监管的 Lightpanda 0.3.3 Renderer；该引擎不依赖 Chrome、Chromium、Blink、WebKit 或 Playwright。Renderer 只监听回环、使用每次启动生成的 bearer token、禁用遥测，并在独立临时 HOME/cache/run 中运行。

Linux/WSL Renderer 由 Bubblewrap 遮蔽仓库、workspace、secrets、Provider、Codex、OneBot、NapCat 凭据和浏览器用户目录。安全代理对 HTTP(S)、重定向、CONNECT、请求数、并发、响应字节和总预算执行统一限制；下载、WebSocket、非 GET 与不受支持资源类型失败关闭。Renderer 不保存 Cookie 或原始 HTML。发行形态忽略宿主 Lightpanda 覆盖，只使用 manifest 保护的包内可执行文件；renderer token 由 launcher 生成并通过文件描述符交给 Linux Core 与 Renderer。Linux/WSL 把动态 Renderer 作为发行必需能力，Lightpanda、Bubblewrap 包内运行库、鉴权、真实 namespace probe 或健康值无法验证时，bootstrap 与启动失败；macOS Core 不接收 renderer URL 或 token，动态能力返回明确 unavailable，静态抓取继续可用。

## 6. 代理与平台

Provider、Codex CLI 与联网工具的出站 HTTP(S) 可独立使用代理。优先级为 `SUNABOT_PROXY_URL`、标准 `HTTP_PROXY`/`HTTPS_PROXY`、WSL 默认网关与配置端口探测；`SUNABOT_PROXY_MODE` 支持 `auto|env|wsl-host|off`。`NO_PROXY` 必须包含回环地址和启动器选择的宿主网关。代理 URL 与凭据不得进入日志、状态接口或 Git。

当前发行目标为 `linux/amd64` 与 `linux/arm64`，并支持在 WSL2 的 Linux 用户空间运行。macOS 保留源码形态的 Native Core + NapCat Docker；动态 WebFetch unavailable。业务模块、SQLite schema、workspace 目录和消息语义在 Linux、WSL 与 macOS Native Core 中保持一致，平台差异只存在于组合根、运行 adapter 和部署层。

## 7. 版本、发行与迁移

当前公开版本为 `0.3.0`。`package.json`、`package-lock.json`、`deploy/runtime-contract.json`、组件锁、版本目录与 `packages/platform/releaseCatalog.ts` 必须一致。`GET /api/releases` 返回当前版本和按时间倒序排列的更新日志；根 `CHANGELOG.md` 与 GitHub `v<version>` Release 使用同一版本内容。

Linux amd64/arm64 发行包内置 Node.js `24.18.0`、生产 `node_modules`、Codex CLI `0.139.0`、Lightpanda `0.3.3`、对应源码与许可证、Bubblewrap `0.8.0-2+deb12u1`、Bubblewrap 的 Debian ELF loader 与完整动态库闭包、对应源码与许可、Core、管理台和迁移工具。发行构建要求干净且构建期间 revision 不变，manifest 绑定平台、版本、source commit、组件版本与受保护文件 SHA-256；构建用 loader `--list` 验证全部 Bubblewrap `NEEDED` 库解析到归档内部，再执行真实 namespace probe。受保护集合覆盖根 `sunabot.sh`、Node 版本合同、完整 Core/WebFetch 构建、管理台 `dist`、生产依赖、全部 runtime/tooling、`deploy/` 下的 NapCat Compose 与 entrypoint、`packages/platform/` 运行模块、workspace 初始化配置、bundled Workbench Skill、组件来源和许可；受保护树增加、删除、替换或符号链接化都必须失败关闭。

安装脚本下载发行归档与 SHA-256，每次从下载归档解压新的不可变版本目录，在读取组件锁和运行 bootstrap 前使用包内校验器验证完整 manifest。全部运行时 smoke、NapCat 镜像准备和离线 bootstrap 成功后才原子切换 `current` 软链接；同版本重装不执行或覆盖已有目录，当前目录损坏时由新目录完成原子修复，任一失败保留原 `current`。NapCat/QQ 的公开再分发授权尚未确认，不随 Sunabot 归档重分发。安装完成后的普通启动固定使用 `pull never`，不执行 npm、浏览器或系统包下载。

GitHub `v<version>` tag 发布必须经过完整 `verify`、light/dark visual acceptance，并由 `npm run runtime:release` 再次执行绑定当前 revision 的 user-test release gate 后分别构建 amd64/arm64 归档；任何 deterministic gate、sealed case quorum、正式构建或归档 manifest 失败都禁止创建 GitHub Release。

0.2.0 到 0.3.0 必须停服运行 `npm run upgrade:0.3.0 -- plan|apply|verify|rollback`。plan 在资源与 SQLite 零修改状态检查全部 Agent；apply 只合并目标缺失或字节相同的普通文件，创建全 Agent SQLite 与资源恢复点，再归档旧 `docker-workbench/`；冲突时拒绝覆盖。verify 检查单一 Workbench、固定入口、归档与摘要；rollback 只在迁移后资源无 drift 时恢复。更早版本按目标版本逐级执行对应迁移脚本。

## 8. 灵魂文件

管理台与 `./sunabot.sh soul` 共用 `sunabot.soul` schema version 1。导出只包含当前 Agent Prompt Catalog 中全部 `scope=persona` 文件及来源 metadata；不包含 Agent manifest、管理员、Provider、密钥、QQ、NapCat、SQLite、记忆、头像或 Workbench。

导入必须经过严格 schema、UTF-8、大小、文件映射和摘要校验。预览绑定上传包 SHA-256 与目标全部人格文件的聚合 revision；确认时任一摘要或 revision 变化返回冲突且零写入。有效导入在同一管理写事务中预校验、暂存、备份和替换全部人格文件，并只执行一次 runtime reload；提交或 reload 失败时全量恢复。来源 metadata 不修改目标 Agent ID、名称、manifest、账号或业务数据。
