# 多终端与 workspace

## 原则

- Git 只同步业务代码；`workspace/` 始终属于当前终端且不进入 Git。
- 每个开发终端使用独立 workspace，多个终端不能同时写同一份 SQLite 或登录同一个生产 QQ。
- `git pull --ff-only` 不修改 workspace；更新前后都不能使用 `git reset --hard` 或 `git clean` 处理终端数据。
- 业务库与 session queue 必须作为同一个离线恢复点备份，NapCat 登录态与凭据需要同时保留但分开限制访问。
- 主实例切换期间旧 Core 与 NapCat 停止后，目标实例才能启动。

## 新终端

空白实例：

```bash
git clone https://github.com/CatREFuse/sunabot.git
cd sunabot
./sunabot.sh up
```

首次启动会初始化 workspace、运行令牌和管理员凭据。开发终端使用自己的 QQ 测试账号和 Provider 凭据，不能挂载生产 workspace。

接管已有业务时，先在源终端执行 `./sunabot.sh down`，按 `docs/operations/sqlite-backup-recovery.md` 创建并验证双库恢复点，再把以下目录直接复制到目标终端的空 workspace：

```text
business/
runtime/napcat/
secrets/
```

`cache/`、运行日志、PID 与临时文件不需要迁移。复制目录必须保持在受控访问路径中，不能上传到公共仓库或普通共享目录。

## Agent 配置文件夹

跨终端新增或迁移单个 Agent 时，直接复制该 Agent 的配置文件夹到目标机的本地受控目录，再在管理台“新增 Agent”中选择“选择文件夹”。文件夹是唯一推荐和支持的配置包模型；ZIP 只用于无法选择目录时的管理台兼容输入。不要把配置文件夹直接放进活动 `workspace/business/agents/<agentId>/`：新增 Agent 需要经过服务端预检、默认值补齐、原子发布和注册表登记。

复制前只保留角色配置：`agent.json`、人格 Markdown、最终提示词、允许的系统提示词覆盖、头像和自拍参考图。不得复制 `.env`、Provider/管理员密钥、SQLite、队列、请求日志、备份、QQ 登录态、NapCat 配置或运行目录。管理台会列出缺失组件并以目标当前默认值补齐；未知文件、路径穿越、重复或 Unicode/控制字符异常、链接、超量或损坏 ZIP、无效 JSON/UTF-8/图片均会拒绝，目标已有 Agent ID 或工作区也不会被覆盖。

## 更新代码

```bash
git status --short
git pull --ff-only
./sunabot.sh up
./sunabot.sh doctor
```

存在数据库或 workspace 前向迁移时，按发布文档先停服、备份和校验，再执行迁移。发现旧 `sunabot-qq-runtime` 容器时，改用 `docs/migrations/one-container-to-split-runtime.md`，不能直接启动新运行时。

从 `0.1.0` 或 `0.1.1` 升级到 `0.1.2` 使用版本专用命令：

```bash
npm run upgrade:0.1.2 -- plan
npm run upgrade:0.1.2 -- apply
```

完整前置条件、恢复点、验收和回滚步骤见 `docs/migrations/upgrade-0.1.0-to-0.1.2.md`。

## 终端角色

- 主业务终端：唯一运行生产 Core、NapCat、SQLite 和定时任务的实例。
- 开发终端：使用独立测试 workspace，通过 `./sunabot.sh up --dev` 或生产式模式验证代码。
- 灾备终端：保留可验证的代码版本与离线备份，默认不启动 Core 或 NapCat。

切换主终端前完成源端停服、双库恢复点、业务目录备份、NapCat 登录态备份、目标恢复校验和网络入口切换。目标实例稳定前保留源端数据但保持停机。
