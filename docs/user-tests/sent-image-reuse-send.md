# Sent image reuse setup

## Goal

The Bot sends an image from the canonical Workbench through `send_file` so the next chained turn can verify that the assistant asset was persisted with a reusable media handle.

## Preconditions

This is the first step of the `media.sent-image-reuse` chained suite. Prepare a fresh isolated workspace with the fixture below and retain that workspace only for the second case `media.sent-image-reuse.generate`.

## Expected quality

The Agent must decode the fixture into a PNG and send that exact file as an image asset. The run report must retain the successful `send_file` trace and the mock transport receipt.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.sent-image-reuse.send",
  "title": "Send the workbench image before reusing it",
  "kind": "conversation",
  "goal": "Send one exact workbench PNG and preserve its successful assistant asset receipt for the next chained turn.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": [],
      "workbenchFiles": [
        {
          "path": "fixtures/reference.b64",
          "content": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 910102,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000102,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "把 workbench 的 fixtures/reference.b64 解码为 fixtures/reference.png，然后把这张 PNG 作为图片发给我。",
      "raw_message": "把 workbench 的 fixtures/reference.b64 解码为 fixtures/reference.png，然后把这张 PNG 作为图片发给我。"
    }
  },
  "expected": {
    "requiredTools": [
      "native_bash",
      "send_file"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "native_bash",
      "send_file"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
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
        "id": "sent_asset",
        "description": "send_file successfully sends fixtures/reference.png as one image asset.",
        "minimumScore": 4
      },
      {
        "id": "history_projection",
        "description": "The successful asset receipt is projected into assistant conversation history as one reusable image.",
        "minimumScore": 4
      }
    ]
  }
}
```
