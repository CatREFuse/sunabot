# 单人自拍直接回传

## 用户目标

管理员在 QQ 私聊要求阿罗娜自拍时，阿罗娜调用 `selfie`，系统保存生成图片并自动回传，不再调用 `send_file`。

## 前置条件

使用全新隔离 workspace、阿罗娜 Agent 的受管自拍参考目录、已授权的文本与图像 Provider，以及 mock MessagingPort。测试不连接真实 NapCat，不向真实 QQ 发送消息。

## 质量要求

工具轨迹必须包含成功的 `selfie`，异步完成后必须出现图片资产外发；不得调用 `generate_img` 或 `send_file`，不得向用户输出本地路径、CQ 码、任务元数据或伪造的发送成功文案。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.selfie-direct-delivery",
  "title": "阿罗娜单人自拍直接回传",
  "kind": "conversation",
  "goal": "管理员收到由 selfie 生成并由系统自动发送的阿罗娜单人自拍。",
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
      "message_id": 930201,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000501,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "阿罗娜，坐在什亭之箱水面教室的窗边自拍一张，上午自然光，轻松一点。",
      "raw_message": "阿罗娜，坐在什亭之箱水面教室的窗边自拍一张，上午自然光，轻松一点。"
    }
  },
  "expected": {
    "requiredTools": [
      "selfie"
    ],
    "forbiddenTools": [
      "generate_img",
      "send_file"
    ],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "selfie"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "SEND_FILE_",
      "/Users/",
      "file://",
      "[CQ:"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "selfie_identity",
        "description": "图片保持阿罗娜外观，并符合用户指定的单人、窗边和上午自然光场景。",
        "minimumScore": 4
      },
      {
        "id": "direct_delivery",
        "description": "图片由 selfie 完成后直接回传，工具轨迹中没有 send_file 或模型猜测文件路径。",
        "minimumScore": 4
      }
    ]
  }
}
```
