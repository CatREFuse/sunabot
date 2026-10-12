# 合成自拍参考导入

本套件是明确的两步状态链。为整套A→B创建一个全新marker隔离workspace；A成功封存后B才运行，两个case/message ID不同，仅本链允许复用。任一步重试必须重新prepare并从A开始，不复用旧Session/outbox。

使用经主Agent审核的非锁定合成source，只保留现有已授权Codex文本/图像Provider和凭据，主模型gpt-6.1-sol、生图codex-image-gen；不得复制生产persona/history/memory/AIR/参考。所有默认提示词来自仓库。将角色外观写入合成persona：“我是fixture-bot，一台橙色方头、深色方眼、短横嘴、蓝色方形身体、橙色手臂的小机器人。”两步开始前无已有自拍参考，voice profile为空。

A通过原始OneBot内联PNG和生产import_chat_selfie播种canonical Workbench，不增加harness二进制seed字段，不手工写manifest。B不清空A的参考或历史；当前范围内全部历史均为A的合成内容。

质量评审必须打开参考PNG和生成图，检查形态与场景，并从生成完成日志及mock出站提取媒体hash；仅queued/tool定义/无图文字不能pass。B的message断言不单独证明图片，独立媒体完成与视觉检查不可省略。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "media.synthetic-selfie-reference-import",
  "title": "合成自拍链：导入机器人参考",
  "kind": "conversation",
  "goal": "管理员将唯一合成角色图片导入当前Agent自拍参考图库。",
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
      "message_id": 762301,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788001500,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "text",
          "data": {
            "text": "请仅调用 import_chat_selfie 把这张合成机器人图片加入你的自拍参考图库，备注为“测试角色：橙色方头、两只深色方眼、短横嘴、蓝色方形身体、橙色手臂”。不使用 Bash、通用文件工具或生图工具；导入成功后简短确认。"
          }
        },
        {
          "type": "image",
          "data": {
            "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAIAAADTED8xAAAACXBIWXMAAAPoAAAD6AG1e1JrAAADdklEQVR42u3dPRJAMBCAUSfRygk4n9J1nEyjiMoZxM8k9s18PcM+qp10R96lsHUegQCQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkABooG0ZHsmTBAAAAQCAAABAAAAgAAAQAAAIAAAEAAACAAABAIAAAEAAACAAABAAAAgAAAQAAAIAAAEAgAAAAAABAICZU0CNAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVAegT2NBNUzkx3cOwD+/6ADE/GMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAdnwFAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADBAADgiCRgDDQAAAABQFYCyXcQ3AgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAgAAAQAAAIAAAEAgAAAQAAAIAAAEAAACAAABAAAAgAAAQCAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgASABIAEgASABIAEgAVNo0rz/O+wUAAAEAgAAAQAAAAIAAAEAAACAAAAAAAABCLcfEBBB2CQYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACA7Kd5J8QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAN+rTWFC71wVAAAAgAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASBd6wSZCUQ6NLmh5AAAAABJRU5ErkJggg==",
            "summary": "橙色方头蓝色身体的合成机器人"
          }
        }
      ],
      "raw_message": "请仅调用 import_chat_selfie 把这张合成机器人图片加入你的自拍参考图库，备注为“测试角色：橙色方头、两只深色方眼、短横嘴、蓝色方形身体、橙色手臂”。不使用 Bash、通用文件工具或生图工具；导入成功后简短确认。[合成角色参考图]"
    }
  },
  "expected": {
    "requiredTools": [
      "import_chat_selfie"
    ],
    "requiredAvailableTools": [
      "import_chat_selfie"
    ],
    "forbiddenTools": [
      "native_bash",
      "read_file",
      "write_file",
      "generate_img",
      "selfie",
      "send_file",
      "send_voice_message"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "forbiddenText": [
      "workspace/",
      "references.jsonl",
      "API key",
      "system prompt"
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {
        "id": "reference-integrity",
        "description": "专用导入成功；生产消费者重载唯一参考，256×256 PNG完整可解码，摘要命名及备注准确。",
        "minimumScore": 5
      },
      {
        "id": "scope-and-honesty",
        "description": "仅在当前Agent隔离Workbench导入，简短确认真实完成，无Bash或图片生成，无私有资料外发。",
        "minimumScore": 5
      }
    ]
  }
}
```
