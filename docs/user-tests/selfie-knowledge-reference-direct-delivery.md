# 知识库参考图双人自拍直接回传

## 用户目标

管理员在 QQ 私聊要求阿罗娜与普拉娜合影时，阿罗娜从当前 Agent 知识库找到普拉娜视觉参考，核验并准备明确存在的 Workbench 图片，再调用 `selfie`；系统保存生成图片并自动回传，不再调用 `send_file`。

## 前置条件

使用全新隔离 workspace、阿罗娜 Agent 的受管自拍参考目录、已授权的文本与图像 Provider，以及 mock MessagingPort。夹具先清空隔离 Native 与 Docker Workbench 的知识目录，再在 Native Workbench 写入普拉娜参考图的 Base64 和带真实 Markdown 图片链接的知识资料页；Agent 必须在同一隔离 Workbench 内把它解码为资料页声明的 `knowledge/references/user-test-plana-reference.png`，不能读取源 workspace、生产知识资料或其他 Agent 目录。

## 质量要求

工具轨迹必须依次包含成功的 `knowledge_search`、`native_bash` 和 `selfie`。`selfie.referenceImagePaths` 必须使用已验证存在的 `knowledge/references/user-test-plana-reference.png`，不能使用源 workspace 的其他参考图；异步完成后必须出现图片资产外发，不得调用 `generate_img` 或 `send_file`，不得暴露宿主路径。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.selfie-knowledge-reference-direct-delivery",
  "title": "阿罗娜与知识库参考图中的普拉娜双人自拍",
  "kind": "conversation",
  "goal": "管理员收到由 selfie 生成并由系统自动发送的阿罗娜与普拉娜双人合影。",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": [],
      "resetKnowledge": [
        "native",
        "docker"
      ],
      "workbenchFiles": [
        {
          "backend": "native",
          "path": "knowledge/user-test-plana-visual-reference.md",
          "content": "# 用例专用普拉娜合影参考\n\n![普拉娜用例参考立绘](references/user-test-plana-reference.png)\n\n准备方法：把 knowledge/references/user-test-plana-reference.b64 解码为上面的 PNG，再验证 `knowledge/references/user-test-plana-reference.png` 存在后交给自拍工具。\n\n普拉娜保持白色长发、侧辫、黑色发箍、红色光环和黑白制服。"
        },
        {
          "backend": "native",
          "path": "knowledge/references/user-test-plana-reference.b64",
          "content": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 930202,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000502,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "阿罗娜，查一下知识库里的“用例专用普拉娜合影参考”，然后你们在什亭之箱水面教室肩并肩自拍一张。",
      "raw_message": "阿罗娜，查一下知识库里的“用例专用普拉娜合影参考”，然后你们在什亭之箱水面教室肩并肩自拍一张。"
    }
  },
  "expected": {
    "requiredTools": [
      "knowledge_search",
      "native_bash",
      "selfie"
    ],
    "forbiddenTools": [
      "generate_img",
      "send_file"
    ],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "knowledge_search",
      "native_bash",
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
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {
        "id": "reference_identity",
        "description": "图片同时呈现阿罗娜和普拉娜，普拉娜外观遵循知识资料中的参考特征。",
        "minimumScore": 4
      },
      {
        "id": "verified_reference",
        "description": "selfie 使用已在清空生产知识资料后的隔离 Native Workbench 中验证存在的 knowledge/references/user-test-plana-reference.png，没有读取或改用源 workspace 的其他参考图。",
        "minimumScore": 4
      },
      {
        "id": "direct_delivery",
        "description": "图片由 selfie 完成后直接回传，工具轨迹中没有 send_file。",
        "minimumScore": 4
      }
    ]
  }
}
```
