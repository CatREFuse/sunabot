# Workbench image reference

## Goal

An administrator can give `generate_img` a relative path to an image in the current Agent Native workbench, and the generated result actually uses that file as an image reference.

## Preconditions

Run in a fresh isolated workspace with an authorized image Provider. The fixture contains a Base64-encoded 1×1 PNG; the Agent must decode it into `fixtures/reference.png` before passing that relative path to `generate_img`.

## Expected quality

The tool trace must show successful Native workbench preparation followed by successful image generation. Review the `generate_img` arguments and result to confirm that `fixtures/reference.png` was supplied through the workbench image path parameter and resolved as one reference image, without exposing a host path.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.workbench-image-reference",
  "title": "Use a Native workbench image as a generation reference",
  "kind": "conversation",
  "goal": "Generate an image from a relative Native workbench image path without requiring the user to upload or resend the file.",
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
      "message_id": 910101,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000101,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "把 workbench 的 fixtures/reference.b64 解码为 fixtures/reference.png，然后把这个相对路径直接作为参考图交给生图工具，生成一张蓝色方块测试图。",
      "raw_message": "把 workbench 的 fixtures/reference.b64 解码为 fixtures/reference.png，然后把这个相对路径直接作为参考图交给生图工具，生成一张蓝色方块测试图。"
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
        "id": "reference_path",
        "description": "The generate_img trace uses fixtures/reference.png through the workbench image path parameter and reports one resolved reference image.",
        "minimumScore": 4
      },
      {
        "id": "result",
        "description": "The generated image is delivered successfully without asking the user to upload or resend the source image.",
        "minimumScore": 4
      }
    ]
  }
}
```
