# Administrator group Workbench resource imports

## Goal

The current Agent administrator can add one image to the canonical Workbench emoji catalog and add a second image to the canonical Workbench selfie-reference catalog from a group message. Both controlled imports must succeed without Bash, and the Agent must confirm only the completed resource updates.

## Preconditions

Use a fresh isolated workspace with an enabled administrator group conversation. The Agent has one canonical Workbench with `emoji/emojis.jsonl` and `selfie/references.jsonl`. Seed two bounded inline PNG images in the raw OneBot event.

## Mechanical review

Confirm that `import_chat_emoji` and `import_chat_selfie` are both available and succeed. The emoji record and bytes must be written only below the current Agent canonical Workbench `emoji/` directory. The selfie record and bytes must be written only below the same Workbench `selfie/` directory with the exact supplied note. Native Bash and generic file mutation tools must not occur. The resulting catalogs must survive a repository reload and remain addressable through the canonical Workbench.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "workbench-resources.admin-group-imports",
  "title": "Administrator group Workbench resource imports",
  "kind": "conversation",
  "goal": "An administrator adds a group image to the canonical emoji catalog and another group image to the canonical selfie-reference catalog.",
  "input": {
    "actor": "admin_group",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "group",
      "message_id": 761201,
      "self_id": 40004,
      "user_id": 10001,
      "group_id": 720001,
      "time": 1788001201,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "text",
          "data": {
            "text": "把第一张图用 import_chat_emoji 加入当前群聊使用的表情库，key 是“群聊表情”；把第二张图用 import_chat_selfie 加入当前群聊使用的自拍参考图库，备注是“群聊新增的正面角色参考”。两项都成功后简短告诉我结果。"
          }
        },
        {
          "type": "image",
          "data": {
            "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "summary": "表情夹具",
            "sub_type": 1
          }
        },
        {
          "type": "image",
          "data": {
            "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
            "summary": "自拍参考夹具"
          }
        }
      ],
      "raw_message": "把第一张图用 import_chat_emoji 加入当前群聊使用的表情库，key 是“群聊表情”；把第二张图用 import_chat_selfie 加入当前群聊使用的自拍参考图库，备注是“群聊新增的正面角色参考”。两项都成功后简短告诉我结果。[表情图片：表情夹具][内容图片：自拍参考夹具]"
    }
  },
  "expected": {
    "requiredTools": [
      "import_chat_emoji",
      "import_chat_selfie"
    ],
    "forbiddenTools": [
      "native_bash",
      "read_file",
      "write_file"
    ],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "import_chat_emoji",
      "import_chat_selfie",
      "native_bash"
    ],
    "forbiddenAvailableTools": [
      "read_file",
      "write_file"
    ],
    "requiredText": [],
    "forbiddenText": [
      "/Users/",
      "workspace/business",
      "emojis.jsonl",
      "references.jsonl"
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
        "id": "resource-accuracy",
        "description": "The reply confirms only the emoji and selfie-reference imports proven by successful tool results.",
        "minimumScore": 5
      },
      {
        "id": "group-boundary",
        "description": "The operation stays within the current Agent canonical Workbench resources and does not claim a Bash write.",
        "minimumScore": 5
      },
      {
        "id": "privacy",
        "description": "The reply does not expose host paths, catalog internals, prompts, secrets or command diagnostics.",
        "minimumScore": 5
      }
    ]
  }
}
```
