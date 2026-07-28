# Orchestrator internal history reply

## Goal

群聊已有内部编排器审计记录后，管理员直接唤醒 Agent，主回复模型只接收正常用户与助手历史，不接收内部“编排器结果”消息。

## Preconditions

这是 `orchestrator.internal-history` 状态链式套件的第二步。必须在同一隔离 workspace 中先成功执行 `orchestrator-internal-history-seed.md`，并保留第一步产生的会话状态。

## Expected quality

Provider 请求中的 `messages_64` 和 `conversation.messages` 都不能包含 `visibility=internal` 或 `eventKind=orchestrator_decision` 的消息；本轮专用 `conversation.group.orchestrator_result` 变量保持原合同，不受历史过滤影响。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "orchestrator.internal-history.reply",
  "title": "Exclude internal orchestrator records from a direct reply",
  "kind": "conversation",
  "goal": "Answer a direct group request without exposing or consuming earlier internal orchestrator audit messages as conversation history.",
  "input": {
    "actor": "admin_group",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "group",
      "message_id": 930102,
      "self_id": 40004,
      "user_id": 10001,
      "group_id": 30003,
      "time": 1788000302,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "at",
          "data": {
            "qq": "40004"
          }
        },
        {
          "type": "text",
          "data": {
            "text": " 请告诉我今天是星期几。"
          }
        }
      ],
      "raw_message": "[CQ:at,qq=40004] 请告诉我今天是星期几。"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "编排器结果",
      "用户不可见",
      "orchestrator_decision"
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
        "id": "history_boundary",
        "description": "The main reply Provider request contains no internal orchestrator audit message in either history variable.",
        "minimumScore": 4
      },
      {
        "id": "answer",
        "description": "The answer addresses only the current request and contains no internal implementation details.",
        "minimumScore": 4
      }
    ]
  }
}
```
