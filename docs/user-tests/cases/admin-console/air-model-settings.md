# 互动约定模型设置

## 用户目标

管理员在「Agent 设置 → Agent 行为 → 互动约定」选择当前 Agent 的模型，互动约定保存使用所选模型，不再隐式依赖公共默认模型。

## 角色与环境

- 管理台：已认证管理员，隔离配置，两个 Agent 使用不同回复模型。
- 主对话：管理员私聊，通过原始 OneBot 入站触发 `read_air`；仅使用合成称呼约定，不连接真实 QQ。
- 公共默认模型模拟返回 HTTP 400；Agent 回复模型及独立互动约定模型返回完整 AIR 文本。
- 桌面 1440×900、移动端 390×844；亮色及暗色。

## 操作与预期

1. 打开 Agent 行为，互动约定默认显示「跟随回复模型」。打开页面不自动写入配置。
2. 选择独立模型并重新加载，设置保留；切换 Agent 不串用模型。
3. 私聊输入「以后在这个私聊中叫我林老师」，`read_air` 使用独立模型，成功原子写入完整 AIR，并重载人格。
4. 恢复「跟随回复模型」，之后的调用使用该 Agent 当前回复模型；更新回复模型后继续跟随。
5. 旧客户端未提交该字段时保留既有设置；新客户端提交空字符串明确恢复跟随。
6. Provider 失败时返回失败结果，已有 AIR 不变；设置不影响其他工具、共享 Provider 或其他 Agent。

## 验证与质量

路由与真实文件持久化由隔离 Runtime 测试覆盖；配置测试覆盖保存、重载、兼容旧配置与错误输入；浏览器测试覆盖设置确认、刷新、亮暗主题及窄屏溢出。真实外部模型验收仅在获得本轮授权后执行；未执行时明确报告边界。

## 2026-10-19 验证记录

WSL 隔离工作区完整 `npm run verify` 通过，包含 3,192 项单元测试、43 项 harness、43 项集成测试、153 项迁移回归、84 项运行时冒烟和 53 项浏览器回归。互动约定专项视觉测试在亮暗主题下通过，桌面及手机截图已人工检查。两份原始 OneBot 入站报告分别覆盖跟随回复模型和独立模型，均通过独立质量评审、seal 和 gate；它们使用本地合成 SSE 与 mock MessagingPort，不代表真实外部模型或 QQ 外发验收。新代码部署及重启另行确认。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "admin.air-model-settings",
  "title": "互动约定使用当前 Agent 模型",
  "kind": "conversation",
  "goal": "管理员私聊中的称呼约定成功写入 AIR，调用当前 Agent 的模型。",
  "input": {
    "actor": "admin_private", "accountId": "primary", "selfId": "40004", "replyEnabled": true,
    "fixture": { "air": "# 互动约定\n\n当前私聊：回答保持简洁。", "workingMemory": [], "longTerm": [], "userProfiles": [] },
    "event": {
      "post_type": "message", "message_type": "private", "message_id": 931019,
      "self_id": 40004, "user_id": 93001, "time": 1792407600,
      "sender": { "nickname": "测试用户" },
      "message": "以后在这个私聊中叫我林老师，请记住。",
      "raw_message": "以后在这个私聊中叫我林老师，请记住。"
    }
  },
  "expected": {
    "requiredTools": ["read_air"], "forbiddenTools": [],
    "requiredText": ["林老师"], "forbiddenText": [],
    "minimumOutboundCount": 1, "maximumOutboundCount": 2
  },
  "quality": { "criteria": [
    { "id": "scope", "description": "称呼仅适用于当前私聊，保留原有简洁约定。", "minimumScore": 4 },
    { "id": "accuracy", "description": "成功写入完整 AIR 后确认，没有虚构群聊约定。", "minimumScore": 4 }
  ] }
}
```
