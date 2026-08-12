# Administrator private chat: silent completion

## Preconditions

Use a benign administrator-private fixture that requests an explicitly silent outcome. This case exists separately because a successful `no_reply` call must result in no normal text or asset; when `pokeOnNoReply` is enabled, one durable poke is the expected terminal interaction.

The review confirms `no_reply` has a succeeded `tool.call`, the Session reaches completion, exactly one poke is placed on the mock transport, and no text, asset, or deferred completion is emitted. A queued or failed silent call is not success.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "system-tools.admin-private-no-reply",
  "title": "Administrator private silent completion",
  "kind": "conversation",
  "goal": "The administrator's explicit silent fixture request finishes with only the configured no-reply poke.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 760106,
      "self_id": 40004,
      "user_id": 171419991,
      "time": 1788000106,
      "sender": {"nickname": "fixture-admin"},
      "message": "这是静默完成夹具。请使用静默结束，不要发送任何文字、文件、图片、语音或行动中消息。",
      "raw_message": "这是静默完成夹具。请使用静默结束，不要发送任何文字、文件、图片、语音或行动中消息。"
    }
  },
  "expected": {
    "requiredTools": ["no_reply"],
    "forbiddenTools": ["assistant_text", "send_file", "send_voice_message"],
    "requiredAvailableTools": ["no_reply"],
    "requiredText": [],
    "forbiddenText": [],
    "requiredOutboundKinds": ["poke"],
    "forbiddenOutboundKinds": ["message", "asset"],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 1
  },
  "quality": {
    "criteria": [
      {"id": "silence", "description": "No text or asset is emitted; the configured no-reply poke is the only captured interaction.", "minimumScore": 5},
      {"id": "containment", "description": "The case causes no unrelated tool use or state change.", "minimumScore": 5}
    ]
  }
}
```
