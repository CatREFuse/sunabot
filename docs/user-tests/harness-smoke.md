# Main-conversation harness smoke

## Goal

Prove that a non-administrator private OneBot message reaches the isolated Runtime and produces one captured user-facing reply without requiring a tool.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.main-conversation-smoke",
  "title": "Main conversation smoke",
  "kind": "conversation",
  "goal": "A non-administrator private message receives one concise reply through the complete harness path.",
  "input": {
    "actor": "user_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 990001,
      "self_id": 40004,
      "user_id": 99112233,
      "time": 1788000000,
      "sender": {
        "nickname": "fixture-user"
      },
      "message": "请用一句简短的话回复：夹具主对话已收到。",
      "raw_message": "请用一句简短的话回复：夹具主对话已收到。"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [
      "system_config",
      "native_bash"
    ],
    "requiredText": [],
    "forbiddenText": [
      "workspace/",
      "API key"
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {
        "id": "relevance",
        "description": "The reply directly acknowledges the fixture message.",
        "minimumScore": 4
      },
      {
        "id": "conciseness",
        "description": "The reply is concise and contains no internal implementation details.",
        "minimumScore": 4
      }
    ]
  }
}
```
