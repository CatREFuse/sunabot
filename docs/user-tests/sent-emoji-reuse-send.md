# Sent emoji reuse setup

## Goal

The Bot sends one image from its own emoji catalog so the next chained turn can verify that the successfully delivered sticker is persisted as reusable assistant media.

## Preconditions

This is the first step of the `media.sent-emoji-reuse` chained suite. Prepare a fresh isolated workspace whose canonical Workbench emoji catalog contains the key `汗颜`, run this case, and retain that workspace only for the second case `media.sent-emoji-reuse.generate`.

## Expected quality

The Agent must send only the requested catalog sticker. The successful mock receipt must create one assistant conversation image backed by an immutable conversation archive URL and expose one `message:<message-id>:image:0` handle. The pure-sticker projection must remain excluded from memory enqueue and compression.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.sent-emoji-reuse.send",
  "title": "Send a catalog emoji before reusing it",
  "kind": "conversation",
  "goal": "Send one exact catalog emoji and preserve its successful assistant media receipt for the next chained turn.",
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
      "message_id": 910104,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000104,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "只回复你表情库里的 [/汗颜]，不要添加文字。",
      "raw_message": "只回复你表情库里的 [/汗颜]，不要添加文字。"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [
      "generate_img",
      "selfie",
      "send_file",
      "native_bash"
    ],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "/Users/",
      "file://",
      "[图片]"
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
        "id": "catalog_sticker",
        "description": "The outbound message contains the requested catalog image as one sticker and no visible text.",
        "minimumScore": 5
      },
      {
        "id": "history_projection",
        "description": "The successful sticker receipt creates one assistant image backed by a conversation archive URL and exposes one historical media handle.",
        "minimumScore": 5
      },
      {
        "id": "memory_boundary",
        "description": "The pure-sticker projection is available to later image generation without entering memory enqueue or compression.",
        "minimumScore": 5
      }
    ]
  }
}
```
