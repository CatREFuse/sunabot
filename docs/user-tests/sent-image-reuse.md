# Sent image reuse

## Goal

After `send_file` sends a workbench image, the next message can refer to that assistant image by the exact historical media handle and use it as a `generate_img` reference.

## Preconditions

This is the second step of the `media.sent-image-reuse` chained suite. Run it in the same isolated workspace immediately after a distinct first-step case has created `fixtures/reference.png` and successfully sent it with `send_file`. The first-step send must have a distinct OneBot message ID and a captured remote asset receipt.

## Expected quality

The previous assistant asset must appear in conversation history as one image with a `message:<message-id>:image:0` handle. The `generate_img` trace must use that exact handle and resolve it to the immutable image bytes archived when the asset was sent.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.sent-image-reuse.generate",
  "title": "Reuse an image sent by the Bot",
  "kind": "conversation",
  "goal": "Regenerate from the exact image that the Bot sent in the preceding chained turn.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 910103,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000103,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "用你上一条消息发给我的那张图片作为精确参考图重新生成，不要让我重新上传。",
      "raw_message": "用你上一条消息发给我的那张图片作为精确参考图重新生成，不要让我重新上传。"
    }
  },
  "expected": {
    "requiredTools": [
      "generate_img"
    ],
    "forbiddenTools": [],
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
      "asset"
    ],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {
        "id": "exact_handle",
        "description": "The prompt history exposes one handle for the preceding assistant image and generate_img uses that exact handle.",
        "minimumScore": 4
      },
      {
        "id": "immutable_reference",
        "description": "The resolved reference is the archived image that was actually sent, with no request to resend and no host path disclosure.",
        "minimumScore": 4
      }
    ]
  }
}
```
