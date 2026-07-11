# 隔离运行时冒烟

`runtime-smoke.ts` 验证两个真实链路：默认 Provider 返回非空文本，以及隔离 NapCat 通过 OneBot action 向配置中的 `bot.adminQq` 发送标记消息。所有命令都要求显式绝对路径 `SUNABOT_WORKSPACE`，凭据只从该 workspace 内读取，控制台不输出密钥或模型回复正文。

## 安全边界

- 不得把生产 `/srv/sunabot/workspace` 或主工作树的 `workspace` 用作测试目录。
- OneBot 测试必须使用独立 NapCat 状态和专用测试 QQ；不得让生产 QQ 在第二个 NapCat 中重复登录。
- 若已知生产 bot QQ，执行时同时设置 `SUNABOT_PRODUCTION_QQ`；脚本发现测试账号与其相同会拒绝发送。
- 测试 NapCat 只保留名为 `sunabot-smoke` 的反向 WebSocket client，固定连接独立回环端口，不能同时连接生产 8787 或远程地址。
- `preflight` 只读文件并短暂检查本机端口，不访问模型、不连接 QQ、不发送消息。
- 真实 Provider 和 OneBot 测试分别有命令行参数与临时环境变量两道执行闸门。

## 准备隔离 workspace

可从现有 workspace 只复制当前默认 Provider 的配置、凭据与 Agent 文件；脚本不会复制其他 Provider key、Bark URL、管理员凭据、OneBot token 或 QQ 登录态：

```bash
npm run smoke:prepare -- \
  --source /srv/sunabot/workspace \
  --destination /srv/sunabot-smoke/workspace \
  --confirm-copy-provider-credential
```

也可按 `deploy/runtime-contract.json` 手工准备独立的 `business/config/sunabot.json`、`secrets/runtime.env`、`runtime/napcat` 状态和 Agent 文件。工具从运行时契约解析这些路径，不依赖调用目录。Provider key、OneBot token 和 QQ 登录状态不能提交 Git。然后创建隔离标记并生成测试 OneBot client：

```bash
export SUNABOT_WORKSPACE=/srv/sunabot-smoke/workspace
export SUNABOT_SMOKE_ONEBOT_PORT=18878
npm run smoke:runtime -- init --confirm-isolated-workspace
npm run smoke:runtime -- configure-onebot --confirm-isolated-workspace
npm run smoke:runtime -- preflight
```

测试 Provider 的 `apiKeyEnv` 必须存在于该 Provider 的 workspace 内 env 文件中。Codex 订阅也必须把短期测试凭据放入隔离 `secrets/runtime.env`，脚本不会回退读取生产进程环境或全局登录凭据。测试结束后删除隔离凭据。

## 真实测试

Provider 请求：

```bash
export SUNABOT_SMOKE_ALLOW_PROVIDER_REQUEST=1
npm run smoke:runtime -- provider --execute-provider
```

OneBot 测试需要先启动使用该 workspace、该端口和专用测试 QQ 的隔离 NapCat。脚本会先调用 `get_login_info`，确认登录 QQ 等于隔离 `secrets/runtime.env` 中的 `NAPCAT_ACCOUNT`，再发送消息并严格校验 `status=ok`、`retcode=0`、匹配的 `echo` 和非空 `message_id`：

如果测试账号是在扫码后才确定，可临时设置 `SUNABOT_SMOKE_NAPCAT_ACCOUNT`；它优先于 env 文件且不会写回 workspace。仍必须同时设置已知的 `SUNABOT_PRODUCTION_QQ`，相同账号会被拒绝。

```bash
export SUNABOT_SMOKE_NAPCAT_ACCOUNT=专用测试QQ
export SUNABOT_SMOKE_DEDICATED_QQ=1
export SUNABOT_SMOKE_ALLOW_ONEBOT_SEND=1
npm run smoke:runtime -- onebot --execute-onebot
```

两项连续执行：

```bash
export SUNABOT_SMOKE_ALLOW_PROVIDER_REQUEST=1
export SUNABOT_SMOKE_DEDICATED_QQ=1
export SUNABOT_SMOKE_ALLOW_ONEBOT_SEND=1
npm run smoke:runtime -- all --execute-provider --execute-onebot
```

PowerShell 使用 `$env:NAME='value'` 设置同名变量。执行完成后清除三个临时授权变量并停止、删除隔离 NapCat；整个过程不修改或重启生产服务。
