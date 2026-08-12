# Docker workbench absolute image reference

## Historical status

This document freezes a Sunabot 0.2.0 Docker Workbench regression for the `upgrade-0.2.0-to-0.3.0` migration path. It is excluded from the current harness and release gate, and it must not be used as evidence that version 0.3.0 exposes Docker Bash or a Docker Workbench.

## Goal

An administrator can pass `/workbench/...`, the absolute path returned inside Docker Bash, directly to `generate_img`.

## Preconditions

Run in a fresh isolated workspace with Docker Bash and an authorized image Provider. The fixture exists in the isolated Docker workbench.

## Expected quality

The system prompt must tell the Bot that an authorized Bash image path can be passed unchanged through `generate_img.referenceImagePaths`. The tool trace must show Docker Bash creating `/workbench/fixtures/reference.png` and `generate_img` receiving that absolute container path unchanged. The path must resolve to one reference image without exposing the host mount source.

<!-- sunabot-user-test-case:historical-v0.2.0 -->
```json
{
  "schemaVersion": 1,
  "id": "media.workbench-image-docker-absolute-reference",
  "title": "Use a Docker workbench absolute image path",
  "kind": "conversation",
  "goal": "Generate an image from the exact /workbench absolute path returned by Docker Bash.",
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
          "backend": "docker",
          "path": "fixtures/reference.b64",
          "content": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        }
      ]
    },
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
      "message": "用 Docker Bash 把 /workbench/fixtures/reference.b64 解码为 /workbench/fixtures/reference.png，然后把这个绝对路径原样传给生图工具，生成一张蓝色方块测试图。",
      "raw_message": "用 Docker Bash 把 /workbench/fixtures/reference.b64 解码为 /workbench/fixtures/reference.png，然后把这个绝对路径原样传给生图工具，生成一张蓝色方块测试图。"
    }
  },
  "expected": {
    "requiredTools": [
      "docker_bash",
      "generate_img"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "docker_bash",
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
        "description": "generate_img receives /workbench/fixtures/reference.png and resolves one Docker workbench reference.",
        "minimumScore": 4
      },
      {
        "id": "boundary",
        "description": "The generated image is delivered without exposing or accepting a host path outside the authorized workbench.",
        "minimumScore": 4
      }
    ]
  }
}
```
