# Orchestrator internal history seed

## Goal

在隔离群聊中完成一次普通编排器判断，为下一步直接回复留下内部审计记录，同时不向群里发送“编排器结果”等内部文字。

## Preconditions

这是 `orchestrator.internal-history` 状态链式套件的第一步。使用全新隔离 workspace、授权 Provider 和 mock MessagingPort；下一步必须复用同一 workspace，并使用不同的 case 与 message ID。

## Expected quality

请求日志应记录一次完成的群聊编排器判断。无论编排器是否决定自然接话，用户可见输出都不能包含内部事件名称、可见性或结构化审计内容。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "orchestrator.internal-history.seed",
  "title": "Create an internal orchestrator history record",
  "kind": "conversation",
  "goal": "Complete one ambient group orchestration decision without exposing its internal audit record.",
  "input": {
    "actor": "user_group",
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
      "message_type": "group",
      "message_id": 930101,
      "self_id": 40004,
      "user_id": 20002,
      "group_id": 30003,
      "time": 1788000301,
      "sender": {
        "nickname": "fixture-member"
      },
      "message": "大家今天晚饭想吃什么？",
      "raw_message": "大家今天晚饭想吃什么？"
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
    "requiredOutboundKinds": [],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 1
  },
  "quality": {
    "criteria": [
      {
        "id": "internal_record",
        "description": "The request trace contains a completed orchestrator decision while no internal audit label or payload is exposed to the group.",
        "minimumScore": 4
      },
      {
        "id": "conversation_fit",
        "description": "Any optional reply is natural for the group message and contains no implementation details.",
        "minimumScore": 4
      }
    ]
  }
}
```
