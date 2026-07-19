# 产品范围与运行结构

[返回当前系统规范索引](./index.md)

## 1. 产品范围

sunabot 是面向个人自托管场景的 QQ 多 Agent 服务。系统通过 OneBot v11 反向 WebSocket 接入多个独立 NapCat 账号，每个 QQ 账号归属一个 Agent；各 Agent 以独立人格处理私聊和用户群聊，支持上下文回复、群聊编排、长期记忆、用户画像、文件读取、联网搜索、图像生成、自拍、本地克隆语音、Codex 异步任务、本地 Web Chat 和管理台。

当前运行目标是单实例、单管理员、多 Agent，每个 Agent 可接入多个 QQ。多租户、完整 OneBot v12 和公网多用户管理台不属于当前版本。模型、正常回复重试、共用开关和公共系统提示词由所有 Agent 共享；Bot 行为、人格提示词、自拍提示词改写、可选系统提示词覆盖、语音开关、默认语言、逐语言参考音频、记忆、会话、图片历史、异步队列和 Agent workspace 按 Agent 隔离。

定时任务是当前 Agent 的主动回调能力。每项任务保存名称、启用状态、任务上下文、cron 或单次触发计划，以及一个或多个既有 QQ 会话目标和各目标的结构化 @ 对象。每次到期只触发当前 Agent 生成一份最终正文，再把同一正文经各目标会话的 Session 队列和 durable outbox 分别投递；目标账号、会话和 @ 对象按任务快照执行，不能因当前管理台选择、后续任务编辑或其他 Agent 状态漂移。任务定义、运行记录、会话事件和 outbox 均按 Agent 隔离，Core 重启后从持久状态恢复。

## 2. 运行结构

```text
宿主机 ./sunabot.sh
├── Sunabot Core（Native 或 Docker）
│   ├── 127.0.0.1:8787 管理 API 与 Vue 管理台
│   ├── :8788 OneBot v11 反向 WebSocket（强制 token）
│   ├── AgentRuntimeManager
│   │   └── 每个启用 Agent 一个 SunaRuntime / SessionCoordinator
│   └── Agent 注册主库 / 各 Agent 业务库与队列库
├── MOSS-TTS-Nano 本地合成服务（独立进程或私有网络服务）
│   ├── Native Core 默认访问 127.0.0.1:18083
│   └── 只接收文本与参考音频，返回 WAV 字节
└── NapCat Docker × QQ 账号
    ├── 每个账号独立容器、配置与 QQ 登录态
    ├── 127.0.0.1:6099 起的独立 NapCat WebUI 端口
    └── 携带 account_id 的 OneBot 事件、action 与 base64 媒体
```

NapCat 在 macOS、WSL2 和 Linux 上始终运行于独立 Docker 容器。Sunabot Core 可以在宿主环境 Native 运行，也可以作为独立 Core 容器运行；根目录 `./sunabot.sh` 统一负责初始化、配置、启动顺序、健康检查、停止和日志。`SUNABOT_CORE_MODE=auto` 在 macOS 选择 Native Core，在 WSL2/Linux 选择 Docker Core，也可显式选择 `native` 或 `docker`。

`status`、`doctor`、管理 API 和平台入口共用 schema v1 的只读运行探针，分别报告 liveness、readiness 与 capability。探针统一核对 workspace、迁移状态、Core、OneBot、每个 QQ、Provider、Codex、bubblewrap、MCP OAuth 凭据库与 stdio 隔离后端；Docker Core 的 bubblewrap 探针必须与真实 `workspace_bash` 使用同一组 user、PID、UTS、IPC、network、cgroup namespace，且与固定 seccomp clone 掩码一致。QQ 临时离线只降低 readiness，不把 Core 判为死亡。Office 正文解析由生产 Node 依赖提供，不再作为独立宿主 capability 探测。Provider readiness 同时区分配置完成和有界健康请求验证成功，密钥只进入对应鉴权请求头。MCP OAuth 或 stdio 未配置时只关闭对应可选能力，非法的已配置值由 doctor 报告稳定配置错误。公开 `/healthz/runtime` 只返回 schema 与 liveness，账号和能力明细只通过管理员鉴权接口返回。

管理台“配置医生”是独立于运行探针的系统配置检查与修复能力，当前只处理 `workspace/business/config/sunabot.json`。它先执行本地确定性扫描，再允许管理员显式发起一次无工具的 AI 结构化建议，并在确认后通过管理 API 应用受限修改；Agent manifest、提示词、凭据、SQLite 和其他 workspace 文件不在当前范围内。该能力不改变 `./sunabot.sh doctor` 的只读语义，当前也没有配置医生 CLI 离线修复入口。

首次运行使用带 HMAC 的持久 journal；workspace 完整父目录链在 marker、配置、凭据、SQLite、注册表或运行目录写入前逐级拒绝用户符号链接。主库 schema、队列 schema、关键表列、约束、外键和索引全部通过后才能完成首次运行；每个持久化边界支持幂等继续或受控回滚，回滚保留未知文件。`help` 成功退出且不安装依赖；`status`、`doctor`、`logs` 和 `down` 不触发依赖安装，只有 `up`、`start`、`restart` 或显式 `bootstrap` 可以安装依赖。

统一 launcher 在 `up`、`start`、`down` 和 `restart` 的运行状态检查前核对当前 workspace 的 NapCat Compose one-off 探针。Docker `ps` 仍报告探针存在而 `inspect` 返回对象不存在时，macOS Colima 的交互终端必须在明确告知其他 Docker 容器会短暂中断后取得确认，随后重启 Colima、等待 Docker Engine 就绪并复验悬空记录消失；非交互命令和其他 Docker Engine 必须失败关闭并返回明确操作。该恢复不能自动执行数据迁移，也不能放宽活动容器、端口、恢复点或迁移标记门禁。

`up`、`start` 与 `restart` 必须进入同一清空后启动流程。launcher 只能停止同时通过仓库命令签名与精确 `SUNABOT_WORKSPACE` 环境验证的 Native Core 进程组，以及带当前 workspace 标签的 Docker 容器和运行网络；身份不明或 PID 复用的进程不能收到信号。清理必须覆盖 account runtime daemon、全部 Core 形态、全部 NapCat 与 Compose one-off，并在 launcher state、同源进程、Docker 对象和 8787、8788、开发模式 5173 端口全部清空后才能启动下一实例。随后必须启动所选 Core、注册表中全部已启用 NapCat 和 account runtime daemon；Core、管理 API、OneBot listener 与 account runtime daemon 连续稳定，且所有 liveness/readiness 失败项清零后命令才能退出 0，可选 capability 降级不阻塞启动。Native OneBot Compose 探针必须有外层期限。带删除标记的 NapCat 目录只有在注册表已经移除对应账号后才能清理，不能在 Agent 删除事务的停用阶段破坏注册集合完整性。

Native Core 启动时必须通过独立 `deploy/docker/compose.bash.yml` 准备 `sunabot-bash` 强隔离镜像，供 macOS 管理员私聊 Docker backend 与 Native Core 的管理员群聊 restricted 模式使用；构建失败只降低 Bash capability 并输出明确状态，不能阻塞 Core 与 NapCat 的基础 readiness。该镜像不启动常驻服务、不发布端口、不挂载 Docker socket，实际命令仍由逐次 capability 探针和审计门禁控制。

宿主 account runtime daemon 按 workspace 保持单实例。owner 记录以当前用户拥有的 0600 普通文件原子发布，并绑定 workspace 身份、入口、PID/进程组、进程启动身份和随机 owner token；发布、claim 或回收中断时保留可验证的同 inode 恢复证据，只有能够证明旧 owner 已退出或身份失配时才回收。损坏、符号链接、额外硬链接、身份不明或 PID 复用都失败关闭，不能向未证明属于当前 workspace 的进程发送信号。`status` 必须报告 owner 丢失与 split-brain；`down` 和 `restart` 还要发现同 workspace 的旧入口与无参数 daemon，停止全部可证明安全的实例并保留无关进程。

管理 API 只发布到宿主回环 `127.0.0.1:8787`。OneBot 使用专用 `8788` 端口并强制校验 access token：Docker Core 模式通过共享的私有运行网络和 `core` 服务名连接；Native Core 模式由启动器配置容器可达的宿主网关。OneBot 不直接发布到局域网或公网。每个 NapCat WebUI 使用注册表分配的独立端口，仅发布到宿主回环，首个账号默认使用 `127.0.0.1:6099`。

Core 与 NapCat 是独立生命周期和文件系统边界。跨组件出站媒体默认使用 OneBot `base64://`，不能传递或依赖宿主、Core 容器、NapCat 容器之间的共享绝对路径。共享业务配置、公共系统提示词和 Agent 注册表位于 workspace 公共区域；每个 Agent 的人格、自拍提示词改写、可选系统提示词覆盖、SQLite、队列、图片与人工文件位于 `workspace/business/agents/<agentId>/`。每个 QQ 的 NapCat 配置、登录态和运行状态位于 `workspace/runtime/napcat/accounts/<accountId>/`，只挂载给对应 NapCat 容器。平台差异只存在于组合根、运行适配器和部署层，业务与持久化格式保持一致。

MOSS-TTS-Nano 与 Core、NapCat 维持独立进程和文件系统边界。Core 通过 `SUNABOT_MOSS_TTS_NANO_URL` 的 HTTP 接口提交有界文本和参考音频字节，接收 WAV 字节后写入当前 Agent 的内容寻址缓存，再经 Session durable outbox 和 OneBot `base64://` `record` 段外发；MOSS 与 NapCat 都不能直接读取 Agent workspace。Native Core 可以使用默认回环地址；Docker Core 通过 Compose 私有网络别名访问 MOSS，不能依赖容器内 `127.0.0.1` 指向宿主，也不能把合成接口发布到局域网或公网。管理 API 不接触 Docker socket；检查、启动和关闭请求经 workspace 内的受限请求桥交给宿主 account runtime daemon，宿主控制器只操作带当前 workspace 专用标签的固定 MOSS 容器。根入口执行 `up`、`start` 或 `restart` 时，在删除 runtime network 前只断开该 owned Voice endpoint，网络重建后以固定别名重新接入；MOSS 容器和已加载模型不随 Core/NapCat 清空流程重启，同名异主容器必须失败关闭。

生产组合根默认不提供 stdio MCP launcher。`SUNABOT_MCP_STDIO_BACKEND=docker` 只接受包含已预装 server 与批准清单的 digest 固定自定义镜像；`bubblewrap` 只在 Linux/WSL 使用绝对、root 所有且权限为 `0444` 的批准清单。Native 与 Docker Core 都禁止运行时下载 server 依赖。`SUNABOT_MCP_CREDENTIAL_VAULT_KEY` 必须是 32 字节 canonical base64url，缺失时 OAuth 管理端点保持不可用，远端无 OAuth MCP 仍可按自身能力运行。启动、`status` 与 `doctor` 必须使用同一份 `workspace/secrets/runtime.env` 解析 MCP 能力，不能用启动终端的空环境覆盖实际运行配置。

Provider、Codex CLI 与联网工具的出站 HTTP(S) 可独立使用代理。API 在载入 composition root 前由 `packages/platform/proxy.mjs` 解析并安装 Undici dispatcher，优先级为 `SUNABOT_PROXY_URL`、标准 `HTTP_PROXY`/`HTTPS_PROXY`、WSL 默认网关与配置端口探测。`SUNABOT_PROXY_MODE` 支持 `auto`、`env`、`wsl-host` 和 `off`；网关只从当前默认路由动态发现，不写死地址。Native Core 与 Docker Core 使用 `deploy/runtime-contract.json` 中的同一代理契约。`NO_PROXY` 必须包含回环地址、Compose 服务名和启动器选择的宿主网关，代理 URL 与凭据不得进入日志、状态接口或 Git。

后端固定使用 Node.js 24.18.0、TypeScript 和 Fastify，管理台由 Vue 3、Vue Router 和 Vite 构建。`.node-version`、`.nvmrc`、package/lock、CI、Native release manifest、runtime contract、component lock 和 Docker 必须保持同一 Node 版本；`npm run runtime:contract` 静态拒绝入口漂移，但不比较开发机当前进程。Native Core 与 Docker Core 的构建、安装和启动都会执行实际版本检查。生产服务由 `dist/apps/api/main.js` 启动；管理 API、Web 静态资源与 OneBot WebSocket 使用彼此独立的监听边界。Docker Core 的构建阶段必须包含 API 编译直接引用的 `tooling/runtime/` 运行辅助模块；缺失编译输入时失败关闭，不能发布仅能运行旧构建产物的镜像。

Linux Native release 必须保留根 `sunabot.sh`、Node 版本文件、生产依赖锁、管理台构建产物、Core 构建产物、配置模板、Core/NapCat Compose、workspace 与管理员工具；解压后继续通过根入口运行。发行包、源码和 `deploy/native/` 均不包含 Native NapCat 启动脚本或 systemd unit，NapCat 生命周期始终由统一 launcher 通过独立 Docker 容器管理。
