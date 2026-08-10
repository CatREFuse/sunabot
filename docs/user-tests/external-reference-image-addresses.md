# External reference image address

## Goal

管理员提供一个只在本机网络可访问的图片地址时，`generate_img` 能将该图片归档为参考图并完成生成。

## Preconditions

使用全新隔离 workspace、授权图像 Provider、mock MessagingPort，以及独立启动的本机静态图片服务。服务在 `127.0.0.1:19090` 提供一张有效 PNG；它只用于本用例，不使用生产 QQ、NapCat 或管理台服务。

## Expected quality

工具调用使用用户明确给出的图片地址，任务成功归档该图片并发送生成结果。回复不暴露宿主路径、内部服务信息或参考图的查询参数。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.external-reference-image-address",
  "title": "Use an explicitly supplied local-network image address as a generation reference",
  "kind": "conversation",
  "goal": "Generate from an explicitly supplied reference image address that resolves to a local-network host.",
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
      "message_id": 930131,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000313,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "使用 http://127.0.0.1:19090/reference.png 作为唯一参考图，生成一张保留主体配色的海报。",
      "raw_message": "使用 http://127.0.0.1:19090/reference.png 作为唯一参考图，生成一张保留主体配色的海报。"
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
      "无法下载",
      "本地网络",
      "/Users/",
      "file://"
    ],
    "requiredOutboundKinds": [
      "asset"
    ],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "reference_archive",
        "description": "The task accepts the explicit image address, archives exactly one reference image, and does not fail before image generation.",
        "minimumScore": 4
      },
      {
        "id": "delivered_result",
        "description": "The generated image is sent to the user without exposing internal addresses or local file paths.",
        "minimumScore": 4
      }
    ]
  }
}
```
