# Group topic internal reasoning

## Goal

管理员在群聊消息中同时提到两个话题并明确继续其中一个时，主 Agent 在生成回复前自行判断当前话题，只回答用户正在追问的内容。

## Preconditions

使用隔离 workspace，从原始 OneBot 群消息进入生产入站链路。独立话题分类请求、附加索引和专用模型配置均不存在，主回复仍接收完整、按原顺序排列的模型可见群聊消息。

## Expected quality

回复准确聚焦晚饭集合时间，不混入发布检查话题，也不展示话题划分、内部推理、消息 ID、置信度或结构化话题索引。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "conversation.group-topic-internal-reasoning",
  "title": "Resolve the active group topic inside the main reply",
  "kind": "conversation",
  "goal": "Answer the explicitly continued group topic without exposing internal topic reasoning.",
  "input": {
    "actor": "admin_group",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "group",
      "message_id": 940101,
      "self_id": 40004,
      "user_id": 10001,
      "group_id": 30003,
      "time": 1788000401,
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
            "text": " 群里同时在讨论两件事：发布检查已经通过；晚饭集合时间还没定。我接着问晚饭这件事：还是七点在东门集合吗？只回答集合时间。"
          }
        }
      ],
      "raw_message": "[CQ:at,qq=40004] 群里同时在讨论两件事：发布检查已经通过；晚饭集合时间还没定。我接着问晚饭这件事：还是七点在东门集合吗？只回答集合时间。"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "七点",
      "东门"
    ],
    "forbiddenText": [
      "发布检查",
      "thread_context",
      "thread_id",
      "message_id",
      "置信度",
      "内部推理",
      "分类步骤"
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
        "id": "topic_resolution",
        "description": "The answer resolves the dinner topic and does not mix in the release-check topic.",
        "minimumScore": 4
      },
      {
        "id": "reasoning_boundary",
        "description": "The answer contains only the useful reply and exposes no topic-classification process or internal representation.",
        "minimumScore": 4
      }
    ]
  }
}
```
