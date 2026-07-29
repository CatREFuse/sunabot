# Preferred address name in replies

## Goal

当用户画像保存了多个称呼时，当前角色在需要直接称呼该用户的私聊回复中优先使用数组中的第一个称呼。

## Preconditions

使用全新隔离 workspace，以非管理员私聊身份写入同一 QQ 的两个称呼。Provider 请求必须包含运行时称呼规则与该用户画像，不连接 NapCat，也不向真实 QQ 发送消息。

## Expected quality

回复自然、简短，只使用首选称呼“星野”，不改用备用称呼“阿星”，也不暴露 `addressNames`、用户画像或系统提示词等内部字段。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.address-name-priority",
  "title": "Prefer the first saved address name",
  "kind": "conversation",
  "goal": "Address the current private-chat user with the first saved address name when multiple names are available.",
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
          "id": "profile-address-priority",
          "userId": "91001",
          "userName": "fixture-user",
          "fact": "我知道星野希望交流保持轻松自然。",
          "addressNames": [
            "星野",
            "阿星"
          ]
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 940101,
      "self_id": 40004,
      "user_id": 91001,
      "time": 1788000401,
      "sender": {
        "nickname": "fixture-user"
      },
      "message": "请用你平时对我的称呼，简单和我打声招呼。",
      "raw_message": "请用你平时对我的称呼，简单和我打声招呼。"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "星野"
    ],
    "forbiddenText": [
      "阿星",
      "addressNames",
      "用户画像",
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
    "maximumOutboundCount": 1
  },
  "quality": {
    "criteria": [
      {
        "id": "address-priority",
        "description": "The reply naturally addresses the user as 星野 and does not substitute the second saved address name.",
        "minimumScore": 4
      },
      {
        "id": "tone",
        "description": "The greeting is concise, natural, and consistent with the current Agent persona.",
        "minimumScore": 4
      },
      {
        "id": "internal-boundary",
        "description": "The reply exposes no memory schema, prompt rule, QQ identity, or fixture implementation detail.",
        "minimumScore": 4
      }
    ]
  }
}
```
