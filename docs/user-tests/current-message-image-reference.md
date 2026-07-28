# Current message image reference

## Goal

管理员在群聊当前消息中上传图片并要求写实转换时，`generate_img` 使用当前消息的精确媒体句柄，并将一张真实参考图传入图像 Provider。

## Preconditions

使用全新隔离 workspace、授权文本与图像 Provider以及 mock MessagingPort。输入图片来自稳定的公开 PNG，只用于验证当前消息媒体句柄在 dispatch 时完成下载、内容寻址归档并由异步任务解析。

## Expected quality

工具调用必须使用 `message:930103:image:0`，派发快照只能保存图片 SHA-256 与不可变归档 URL，不能保存原始远程 URL；结果中的请求句柄数、已解析句柄数和最终参考图数都应为 1。下载失败允许在初始请求后重试 3 次。参考图无法归档或在 Provider 输入阶段无法解析时任务必须失败，且图像 Provider 保持零调用。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.current-message-image-reference",
  "title": "Use the current group image as an exact generation reference",
  "kind": "conversation",
  "goal": "Generate from the image uploaded in the current group message without losing its exact media handle during deferred dispatch.",
  "input": {
    "actor": "admin_group",
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
      "message_type": "group",
      "message_id": 930103,
      "self_id": 40004,
      "user_id": 10001,
      "group_id": 30003,
      "time": 1788000303,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "at",
          "data": {
            "qq": "40004"
          }
        },
        {
          "type": "image",
          "data": {
            "file": "current-reference.png",
            "url": "https://raw.githubusercontent.com/github/explore/main/topics/typescript/typescript.png"
          }
        },
        {
          "type": "text",
          "data": {
            "text": " 严格使用这张图作为参考，把它转换成写实摄影风格，保留主体结构。"
          }
        }
      ],
      "raw_message": "[CQ:at,qq=40004][CQ:image,file=current-reference.png,url=https://raw.githubusercontent.com/github/explore/main/topics/typescript/typescript.png] 严格使用这张图作为参考，把它转换成写实摄影风格，保留主体结构。"
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
      "没有参考图",
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
        "id": "exact_current_handle",
        "description": "The generate_img call uses message:930103:image:0 and reports one requested handle, one resolved handle, and one final reference image.",
        "minimumScore": 4
      },
      {
        "id": "reference_result",
        "description": "The generated result visibly follows the uploaded image and is delivered without asking the user to resend it.",
        "minimumScore": 4
      }
    ]
  }
}
```
