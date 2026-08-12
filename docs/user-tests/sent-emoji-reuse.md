# Sent emoji reuse

## Goal

After the Bot sends an image from its own emoji catalog, the next message can select that exact historical media handle as a `generate_img` reference.

## Preconditions

This is the second step of the `media.sent-emoji-reuse` chained suite. Run it in the same isolated workspace immediately after `media.sent-emoji-reuse.send` has successfully delivered the catalog sticker with a distinct OneBot message ID.

## Expected quality

The preceding assistant sticker must appear in conversation history with one `message:<message-id>:image:0` handle. The `generate_img` trace must use that exact handle and resolve it to the immutable archived bytes that were sent.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.sent-emoji-reuse.generate",
  "title": "Reuse an emoji sent by the Bot",
  "kind": "conversation",
  "goal": "Generate a new image from the exact catalog emoji that the Bot sent in the preceding chained turn.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 910105,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000105,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "用你上一条消息发出的表情图片作为精确参考图，生成一张保持主要角色特征的新插图，不要让我重新上传。",
      "raw_message": "用你上一条消息发出的表情图片作为精确参考图，生成一张保持主要角色特征的新插图，不要让我重新上传。"
    }
  },
  "expected": {
    "requiredTools": [
      "generate_img"
    ],
    "forbiddenTools": [
      "selfie",
      "send_file",
      "native_bash"
    ],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "generate_img"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "重新上传",
      "重新发一次",
      "/Users/",
      "file://"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {
        "id": "exact_handle",
        "description": "The prompt history exposes one handle for the preceding assistant sticker and generate_img uses that exact handle.",
        "minimumScore": 5
      },
      {
        "id": "immutable_reference",
        "description": "The resolved reference is the archived sticker that was actually sent, with no request to resend and no host path disclosure.",
        "minimumScore": 5
      },
      {
        "id": "new_image",
        "description": "The completed generated image visibly uses the sticker as a reference while producing a new requested illustration.",
        "minimumScore": 4
      }
    ]
  }
}
```
