# 合成自拍直接交付

本套件是明确的两步状态链。为整套A→B创建一个全新marker隔离workspace；A成功封存后B才运行，两个case/message ID不同，仅本链允许复用。任一步重试必须重新prepare并从A开始，不复用旧Session/outbox。

使用经主Agent审核的非锁定合成source，只保留现有已授权Codex文本/图像Provider和凭据，主模型gpt-6.1-sol、生图codex-image-gen；不得复制生产persona/history/memory/AIR/参考。所有默认提示词来自仓库。将角色外观写入合成persona：“我是fixture-bot，一台橙色方头、深色方眼、短横嘴、蓝色方形身体、橙色手臂的小机器人。”两步开始前无已有自拍参考，voice profile为空。

A通过原始OneBot内联PNG和生产import_chat_selfie播种canonical Workbench，不增加harness二进制seed字段，不手工写manifest。B不清空A的参考或历史；当前范围内全部历史均为A的合成内容。

质量评审必须打开参考PNG和生成图，检查形态与场景，并从生成完成日志及mock出站提取媒体hash；仅queued/tool定义/无图文字不能pass。B的message断言不单独证明图片，独立媒体完成与视觉检查不可省略。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.synthetic-selfie-direct-delivery",
  "title": "合成自拍链：机器人自拍直达",
  "kind": "conversation",
  "goal": "管理员收到保持合成机器人身份与指定桌前场景的真实自拍，且得到准确语音未启用说明。",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 762302,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788001501,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请调用 selfie，使用刚才成功导入的唯一合成机器人参考，生成一张你在整洁工作台前检查空白清单的单人自拍。保持橙色方头、两只深色方眼、短横嘴、蓝色方形身体和橙色手臂；自然光，无文字。当前语音功能未启用，请明确说明，不要调用语音、generate_img、send_file、Bash或通用文件工具。",
      "raw_message": "请调用 selfie，使用刚才成功导入的唯一合成机器人参考，生成一张你在整洁工作台前检查空白清单的单人自拍。保持橙色方头、两只深色方眼、短横嘴、蓝色方形身体和橙色手臂；自然光，无文字。当前语音功能未启用，请明确说明，不要调用语音、generate_img、send_file、Bash或通用文件工具。"
    }
  },
  "expected": {
    "requiredTools": [
      "selfie"
    ],
    "requiredAvailableTools": [
      "selfie"
    ],
    "forbiddenTools": [
      "generate_img",
      "send_file",
      "native_bash",
      "read_file",
      "write_file",
      "send_voice_message",
      "import_chat_selfie"
    ],
    "forbiddenAvailableTools": [
      "send_voice_message"
    ],
    "requiredText": [
      "语音功能未启用"
    ],
    "forbiddenText": [
      "reference path",
      "workspace/",
      "API key",
      "system prompt",
      "terminated",
      "没有可用图片"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 5
  },
  "quality": {
    "criteria": [
      {
        "id": "identity-and-scene",
        "description": "实际生成图保留橙色方头、深色方眼、短横嘴、蓝色身体与橙色手臂，单人、整洁工作台、空白清单、自然光；并取得真实生成完成证据。",
        "minimumScore": 4
      },
      {
        "id": "completed-direct-delivery",
        "description": "selfie异步任务真实成功完成，PNG/JPEG可完整解码，mock交付字节/hash与落盘一致且目标为原私聊；不使用send_file或猜测路径。",
        "minimumScore": 5
      },
      {
        "id": "voice-and-privacy",
        "description": "语音工具缺席且明确说明未启用；无源参考地址、宿主路径、凭据、提示词、任务元数据或其他真实角色内容。",
        "minimumScore": 5
      }
    ]
  }
}
```
