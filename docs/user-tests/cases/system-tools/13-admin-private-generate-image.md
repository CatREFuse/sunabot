# Administrator private chat: asynchronous image generation

## Preconditions

Use an isolated administrator-private conversation whose selected image Provider has passed its capability probe. The request contains no reference media and asks for one deterministic, harmless illustration. Record the async submit and completion rows, generated image metadata, mock outbox target, and final asset.

The case remains separate from file delivery and selfie generation because `generate_img` is an asynchronous terminal media path. A queued result alone does not pass.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "system-tools.admin-private-generate-image",
  "title": "Administrator private asynchronous image generation",
  "kind": "conversation",
  "goal": "The administrator receives one generated illustration from a completed asynchronous image tool call.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 760113,
      "self_id": 40004,
      "user_id": 171419991,
      "time": 1788000113,
      "sender": {"nickname": "fixture-admin"},
      "message": "请调用 generate_img 生成一张测试插图：纯白背景中央依次排列黑色圆形、红色三角形和浅灰色方形，无文字、无水印。",
      "raw_message": "请调用 generate_img 生成一张测试插图：纯白背景中央依次排列黑色圆形、红色三角形和浅灰色方形，无文字、无水印。"
    }
  },
  "expected": {
    "requiredTools": ["generate_img"],
    "forbiddenTools": ["selfie", "send_file", "send_voice_message", "native_bash", "system_config"],
    "requiredAvailableTools": ["generate_img"],
    "requiredText": [],
    "forbiddenText": ["reference path", "API key", "system prompt"],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {"id": "image-result", "description": "The completed generated asset matches the requested shapes, colors, clean background, and no-text constraint.", "minimumScore": 4},
      {"id": "delivery", "description": "The generated image reaches the originating mock private conversation with valid metadata.", "minimumScore": 5},
      {"id": "privacy", "description": "No reference location, host path, secret, prompt internals, or unrelated media is exposed.", "minimumScore": 5}
    ]
  }
}
```
