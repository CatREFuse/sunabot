# Tone segmented reply beyond three bubbles

## Goal

管理员在私聊中明确要求四个独立气泡时，Tone 可以输出并发送四个文字气泡，同时默认规则仍建议普通回复最多使用三个气泡。

## Preconditions

使用全新隔离 workspace、授权 Provider、已启用 Tone 和分段回复以及 mock MessagingPort。不得连接 NapCat 或向真实 QQ 外发。

## Mechanical review

确认 Tone 提示词包含“推荐最多 3 个”且允许内容需要时继续拆分；Tone 输出的四个合法 `dialogc/dialog` 节点全部通过宿主门禁，形成四个按原顺序持久化和发送的文字气泡，只有第一个气泡保留引用。

## Expected quality

四个气泡依次包含春、夏、秋、冬四项，没有合并、遗漏、重复或暴露 XML；普通内容仍保持简洁。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "messaging.tone-segmented-more-than-three",
  "title": "Allow four Tone bubbles when the content requires them",
  "kind": "conversation",
  "goal": "Deliver four explicitly requested text bubbles while keeping three as the normal recommendation.",
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
      "message_id": 940202,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000502,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请分成四个独立气泡，按顺序各写一句：春、夏、秋、冬。不要合并。",
      "raw_message": "请分成四个独立气泡，按顺序各写一句：春、夏、秋、冬。不要合并。"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [],
    "forbiddenAvailableTools": [],
    "requiredText": ["春", "夏", "秋", "冬"],
    "forbiddenText": ["<dialog", "<dialogc", "XML"],
    "requiredOutboundKinds": ["message"],
    "forbiddenOutboundKinds": ["asset", "poke"],
    "minimumOutboundCount": 4,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {
        "id": "ordered-bubbles",
        "description": "Four separate user-visible bubbles preserve the requested spring, summer, autumn and winter order without omissions or duplicates.",
        "minimumScore": 5
      },
      {
        "id": "output-boundary",
        "description": "The user sees only the four natural-language bubbles and no XML or internal Tone instructions.",
        "minimumScore": 5
      }
    ]
  }
}
```
