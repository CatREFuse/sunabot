# Direct working-memory write

## Goal

当管理员在私聊中明确要求阿罗娜记住一项短期待办时，主对话模型在当前回复轮直接调用 `add_workmemory`，成功写入当前 Agent 的 `WORKING_MEMORY.md`，不等待后台压缩任务。

## Preconditions

使用全新隔离 workspace，从原始 OneBot 私聊事件进入 production ingress。工作记忆初始为空，Provider 可使用 `add_workmemory`，不连接 NapCat，也不向真实 QQ 发送消息。

## Expected quality

回复确认已经记住明天下午三点前发送评审稿，工作记忆保留时间、动作和完成条件，不出现后台队列、压缩模型、提示词或内部字段。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.add-workmemory-direct-write",
  "title": "Direct working-memory write",
  "kind": "conversation",
  "goal": "The main reply model records an explicit short-term reminder in the same turn.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": []
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 950101,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000501,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "阿罗娜，帮我记住：明天下午三点前把评审稿发给我，发出前要确认附件能打开。",
      "raw_message": "阿罗娜，帮我记住：明天下午三点前把评审稿发给我，发出前要确认附件能打开。"
    }
  },
  "expected": {
    "requiredTools": [
      "add_workmemory"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "add_workmemory"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "评审稿"
    ],
    "forbiddenText": [
      "压缩模型",
      "后台队列",
      "提示词",
      "内部字段"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 1
  },
  "quality": {
    "criteria": [
      {
        "id": "direct-write",
        "description": "The successful add_workmemory call records the deadline, delivery action, and attachment check in the isolated working-memory document.",
        "minimumScore": 5
      },
      {
        "id": "reply-accuracy",
        "description": "The reply confirms only the reminder that was actually written and does not claim a later delivery has already happened.",
        "minimumScore": 4
      },
      {
        "id": "internal-boundary",
        "description": "The reply exposes no queue, model, prompt, fixture, or storage implementation detail.",
        "minimumScore": 4
      }
    ]
  }
}
```
