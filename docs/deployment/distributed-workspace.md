# 分布式终端和 workspace

## 原则

- GitHub 只同步业务代码。
- 每个业务终端拥有自己的 `workspace/`。
- `git pull --ff-only` 不接触 workspace。
- 多终端不能同时写同一份实时 SQLite。
- 百度同步盘只同步 checkpoint 后的加密快照，不直接同步 WAL、SHM 或 NapCat 正在使用的数据库。

## 新终端

```bash
git clone https://github.com/CatREFuse/sunabot.git
cd sunabot
npm ci
npm run workspace:init
```

需要空白实例时，编辑 `workspace/secrets/runtime.env`，初始化管理员密码后构建启动。需要接管已有业务时，从加密快照恢复到空 workspace，并确认该终端是唯一写入者。

## Pull 策略

更新前停止 sunabot，确认业务代码没有未提交修改：

```bash
git status
npm run code:update
```

更新后按版本说明执行数据库迁移，再启动服务并验证 SQLite、管理台和 OneBot。不要用 `git reset --hard` 处理本机 workspace，也不要把 workspace 强行加入 Git。

## 百度同步盘

本机同步目录建议为：

```text
C:\Users\<用户>\Documents\BaiduSyncdisk\sunabot-workspace-sync
```

默认只同步 `sunabot-business.latest.enc` 和 SHA-256 清单，不包含 `cache`、日志或临时文件。`--tier runtime` 可单独快照 NapCat 登录态，`--tier secrets` 必须使用 `SUNABOT_SECRETS_SYNC_KEY_FILE` 指定的独立密钥；业务、运行态和秘密不能共用一个归档。32 字节密钥不进入 Git、不进入同步盘。恢复时先校验 AES-GCM 认证标签，再审计 tar 路径，最后只解压到对应的空 tier。

## 终端角色

- 主业务终端：唯一运行 QQ、SQLite 和定时任务的实例。
- 开发终端：只拉取业务代码，使用独立测试 workspace。
- 灾备终端：保持代码可拉取和加密 workspace 快照可恢复，默认不启动 QQ 服务。

切换主终端前必须停止旧终端、生成最新加密快照、在新终端恢复并校验数据库，然后才启动 NapCat 与 sunabot。
