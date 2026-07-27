# Native workbench absolute image reference

## Goal

An administrator can pass the absolute image path returned by Native Bash directly to `generate_img`.

## Preconditions

Run in a fresh isolated workspace with an authorized image Provider. Native Bash must decode the fixture, run `pwd -P`, and build the image path from that exact workbench root.

## Expected quality

The system prompt must tell the Bot that an authorized Bash image path can be passed unchanged through `generate_img.referenceImagePaths`. The tool trace must show `native_bash` returning the real Native workbench path and `generate_img` receiving that absolute path unchanged. The path must resolve to one reference image without appearing in user-facing output.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.workbench-image-native-absolute-reference",
  "title": "Use a Native workbench absolute image path",
  "kind": "conversation",
  "goal": "Generate an image from the exact absolute Native workbench path returned by Bash.",
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
          "backend": "native",
          "path": "fixtures/reference.b64",
          "content": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        }
      ]
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
      "message": "用 Native Bash 把 fixtures/reference.b64 解码为 PNG，执行 pwd -P，把得到的工作区绝对路径与 fixtures/reference.png 拼接后原样传给生图工具，生成一张蓝色方块测试图。",
      "raw_message": "用 Native Bash 把 fixtures/reference.b64 解码为 PNG，执行 pwd -P，把得到的工作区绝对路径与 fixtures/reference.png 拼接后原样传给生图工具，生成一张蓝色方块测试图。"
    }
  },
  "expected": {
    "requiredTools": [
      "native_bash",
      "generate_img"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "native_bash",
      "generate_img"
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
        "id": "absolute_path",
        "description": "generate_img receives the exact absolute image path derived from Native Bash pwd -P and resolves one workbench reference.",
        "minimumScore": 4
      },
      {
        "id": "boundary",
        "description": "The generated image is delivered without exposing the host path or reading outside the current Agent workbench.",
        "minimumScore": 4
      }
    ]
  }
}
```
