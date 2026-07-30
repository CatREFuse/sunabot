# 解析失败的 QQ 文件仍可导出

## 用户目标

管理员在 QQ 私聊中发送一个正文解析失败但已经完整下载的 PDF 后，阿罗娜仍能把原始 PDF 保存到当前会话允许的 Workbench，并将同一份文件发回当前会话。

## 角色与环境

- 主对话角色：管理员私聊。
- 输入从原始 OneBot v11 `file` 消息段进入 production ingress。
- 使用全新隔离 workspace、mock MessagingPort 和固定损坏 PDF 文件源，不连接真实 NapCat，也不向真实 QQ 外发。
- PDF 保留有效文件头，但正文结构损坏，用于稳定触发获取成功、解析失败。

## 输入与预期

机器人必须调用 `export_chat_media` 导出 `message:885282520:file:0`，再调用 `send_file` 将导出的原件发回。工具成功结果中的 SHA-256 必须对应输入的 16 字节原件。回复不得要求用户重新上传，也不得把解析失败描述成下载失败。

## 质量标准

用户能够收到与原件字节一致的 PDF。回复可说明正文无法解析，但不能声称文件没有下载成功，不能暴露缓存路径、临时地址或内部句柄实现。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "attachments.parse-failed-original-export",
  "title": "Export an acquired PDF after parsing fails",
  "kind": "conversation",
  "goal": "The administrator can export and receive the original PDF even when text parsing fails after acquisition.",
  "input": {
    "actor": "admin_private",
    "accountId": "fixture-secondary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "attachmentSources": [
        {
          "fileId": "fixture-corrupt-pdf",
          "name": "待人工核对.pdf",
          "contentBase64": "JVBERi0xLjcKYnJva2VuCg=="
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 885282520,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1785388920,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "file",
          "data": {
            "name": "待人工核对.pdf",
            "file": "fixture-corrupt-pdf",
            "file_id": "fixture-corrupt-pdf",
            "file_size": 16
          }
        },
        {
          "type": "text",
          "data": {
            "text": "正文如果无法解析，也请导出这条消息里的原始 PDF，并把导出的文件发回给我。"
          }
        }
      ],
      "raw_message": "[CQ:file,file=fixture-corrupt-pdf,file_id=fixture-corrupt-pdf,file_size=16,name=待人工核对.pdf]正文如果无法解析，也请导出这条消息里的原始 PDF，并把导出的文件发回给我。"
    }
  },
  "expected": {
    "requiredTools": [
      "export_chat_media",
      "send_file"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "export_chat_media",
      "send_file"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "无法下载",
      "重新上传",
      "重新发送"
    ],
    "requiredOutboundKinds": [
      "asset"
    ],
    "forbiddenOutboundKinds": [
      "poke"
    ],
    "requiredInboundAttachments": [
      {
        "messageId": "885282520",
        "index": 0,
        "name": "待人工核对.pdf",
        "status": "failed",
        "acquisitionStatus": "acquired",
        "parseStatus": "parse_failed",
        "blobSha256": "f8a5a41c52832585568ca3d6738ef21c83c629d2c3088bfdf0644f8daa7efadf",
        "blobSizeBytes": 16,
        "blobMimeType": "application/pdf",
        "format": "pdf",
        "mimeType": "application/pdf",
        "sizeBytes": 16,
        "sha256": "f8a5a41c52832585568ca3d6738ef21c83c629d2c3088bfdf0644f8daa7efadf",
        "handle": "message:885282520:file:0"
      }
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "original-integrity",
        "description": "The delivered PDF is the acquired 16-byte original with SHA-256 f8a5a41c52832585568ca3d6738ef21c83c629d2c3088bfdf0644f8daa7efadf.",
        "minimumScore": 5
      },
      {
        "id": "state-accuracy",
        "description": "The answer distinguishes a parsing failure from a download failure and does not ask for another upload.",
        "minimumScore": 5
      },
      {
        "id": "privacy",
        "description": "The answer does not expose a cache path, temporary URL, account identifier, or handle implementation.",
        "minimumScore": 5
      }
    ]
  }
}
```
