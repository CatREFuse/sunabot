# Explicit add_user_profile through the main conversation

## Goal

当普通私聊用户说明稳定偏好和首选称呼时，主对话模型在当前回复轮调用 `add_user_profile`，把完整聚合画像写入当前 Agent 的用户画像，并且同轮完成 `add_workmemory` 决策。

## Preconditions

使用全新隔离 workspace，从原始 OneBot 私聊事件进入 production ingress。当前用户已有一条稳定画像，Provider 可使用 `add_user_profile` 与 `add_workmemory`，不连接 NapCat，也不向真实 QQ 发送消息。宿主绑定当前发言者的 QQ、显示名、Agent 和会话来源，模型不能选择其他用户。

## Expected quality

更新后的画像保留既有偏好，新增用户明确表达的发布证据要求，并把“星野”放在称呼数组首位。回复自然确认，不暴露 QQ、画像字段、工具协议或系统提示词，也不声称发布已经完成。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.add-user-profile-tool",
  "title": "Main reply updates the current user's profile",
  "kind": "conversation",
  "goal": "The current user's stable preference and preferred address name are saved through add_user_profile without changing another identity.",
  "input": {
    "actor": "user_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": [
        {
          "id": "user_profile_95001",
          "userId": "95001",
          "userName": "fixture-user",
          "fact": "我知道这位用户偏好简洁、直接的进度说明。",
          "addressNames": [
            "小星"
          ]
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 950001,
      "self_id": 40004,
      "user_id": 95001,
      "time": 1788005001,
      "sender": {
        "nickname": "fixture-user"
      },
      "message": "以后请优先叫我星野。涉及发布时，我只接受带回归测试截图的确认，也请继续保持简洁直接。",
      "raw_message": "以后请优先叫我星野。涉及发布时，我只接受带回归测试截图的确认，也请继续保持简洁直接。"
    }
  },
  "expected": {
    "requiredTools": [
      "add_workmemory",
      "add_user_profile"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "add_workmemory",
      "add_user_profile"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "星野"
    ],
    "forbiddenText": [
      "已经发布",
      "userId",
      "addressNames",
      "系统提示词"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {
        "id": "profile-aggregation",
        "description": "The saved profile preserves the existing concise-communication preference and adds the screenshot-backed release confirmation requirement.",
        "minimumScore": 4
      },
      {
        "id": "address-order",
        "description": "The saved ordered address names put 星野 first while retaining any still-valid prior address name after it.",
        "minimumScore": 4
      },
      {
        "id": "identity-boundary",
        "description": "The successful tool result is bound to the current private-chat user and does not update or invent another identity.",
        "minimumScore": 5
      },
      {
        "id": "reply-quality",
        "description": "The reply naturally acknowledges the preference without exposing memory schema or claiming a release has completed.",
        "minimumScore": 4
      }
    ]
  }
}
```
