# LLM 输入与输出宽容处理

## 用户目标与边界

管理员私聊能正常获得模型回复，模型没有调用记忆工具时也能完成回复。各业务节点接纳提示内容、字段顺序变化、附加字段、代码围栏和可提取的模型结果；内容格式偏差不触发整轮失败或强制重试。

测试使用隔离 workspace 与 mock MessagingPort，禁止向真实 QQ 发消息。账号权限、路径隔离、真实工具执行参数、数据库事务和文件存储容量继续由对应执行边界负责；不得把无法执行的操作标为成功，也不得以缺失的 Dream 压缩字段清空记忆。

## 确定性回归

- Dream 使用第 800 字符为空格的用户画像，重复投影和历史失败输入仍可进入模型调用；不再以输入重新规范化后的摘要变化拒绝运行。
- Dream 输出允许字段换序、附加字段、围栏 JSON 和旧格式；没有压缩正文时保留当前工作记忆，已经存在的新记忆不得被旧快照覆盖。
- Provider 四种协议允许模型直接返回正文，不强制追加工作记忆或用户画像决策；工具权限仍在实际调用时校验。
- Tone、群聊编排、导演、自拍等节点尽可能提取可用结果，原文和缺失字段可区分，不能因格式偏差丢弃整轮结果。
- 真实 Provider 验收仅在取得本轮外部调用授权后执行；确定性夹具需同时检查调用、返回、持久化差异与输出质量。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.llm-permissive-content",
  "title": "LLM permissive input and output",
  "kind": "conversation",
  "goal": "An administrator receives the model reply without a mandatory memory decision or a content-format rejection.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": { "workingMemory": [], "longTerm": [], "userProfiles": [] },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 90101401,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1791957600,
      "sender": { "nickname": "fixture-admin" },
      "message": "请回复：已收到。这条临时测试无需记录记忆。",
      "raw_message": "请回复：已收到。这条临时测试无需记录记忆。"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": ["已收到"],
    "forbiddenText": [],
    "requiredOutboundKinds": ["message"],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      { "id": "reply", "description": "The reply answers the request directly without exposing validation or forcing a memory operation.", "minimumScore": 5 },
      { "id": "preservation", "description": "A plain reply creates no unsolicited memory entry and does not claim that a memory operation occurred.", "minimumScore": 5 }
    ]
  }
}
```
