# QQ 私聊 PDF 文件读取

## 用户目标

管理员在 QQ 私聊中发送一个 PDF 文件后，阿罗娜能够从当前 QQ 账号取得完整文件，读取正文，并依据文件内容回答。

## 角色与环境

- 主对话角色：管理员私聊。
- 输入从原始 OneBot v11 `file` 消息段进入 production ingress。
- 使用全新隔离 workspace、mock MessagingPort 和固定 PDF 文件源，不连接真实 NapCat，也不向真实 QQ 外发。
- 测试账号使用非 `primary` 的 `accountId`，用于验证文件查询不会丢失当前账号。

## 输入与预期

文件名为“湖北省耕地质量等级评价成果交接单.pdf”，PDF 正文包含固定校验文本 `PDF-ATTACHMENT-ROUTING-OK-20260730`。机器人应在回复中准确返回该文本，不得显示读取失败、要求用户改名重发或声称无法下载。

## 质量标准

回答必须来自 PDF 正文，清楚说明文件已成功读取，不虚构文件中不存在的内容，也不暴露缓存路径、下载地址、账号路由或内部错误。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "attachments.qq-private-pdf",
  "title": "QQ private PDF attachment",
  "kind": "conversation",
  "goal": "The administrator sends a PDF in a QQ private chat and receives an answer grounded in the complete PDF content.",
  "input": {
    "actor": "admin_private",
    "accountId": "fixture-secondary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "attachmentSources": [
        {
          "fileId": "fixture-private-pdf",
          "name": "湖北省耕地质量等级评价成果交接单.pdf",
          "contentBase64": "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA2NSA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDIwIDEwMCBUZCAoUERGLUFUVEFDSE1FTlQtUk9VVElORy1PSy0yMDI2MDczMCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzNTYgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjYKJSVFT0YK"
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 885282519,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1785388860,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "file",
          "data": {
            "name": "湖北省耕地质量等级评价成果交接单.pdf",
            "file": "fixture-private-pdf",
            "file_id": "fixture-private-pdf",
            "file_size": 609
          }
        }
      ],
      "raw_message": "[CQ:file,file=fixture-private-pdf,file_id=fixture-private-pdf,file_size=609,name=湖北省耕地质量等级评价成果交接单.pdf]"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "PDF-ATTACHMENT-ROUTING-OK-20260730"
    ],
    "forbiddenText": [
      "读取失败",
      "无法下载",
      "重新发送"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "requiredInboundAttachments": [
      {
        "messageId": "885282519",
        "index": 0,
        "name": "湖北省耕地质量等级评价成果交接单.pdf",
        "status": "ready",
        "format": "pdf",
        "mimeType": "application/pdf",
        "sizeBytes": 609,
        "sha256": "fc1fe02beddbcfb326b92c7f3a1574b02c6eea044b75cfccf54ac7f6de889fcb",
        "pageCount": 1,
        "handle": "message:885282519:file:0"
      }
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {
        "id": "grounding",
        "description": "The answer returns the exact verification text from the parsed PDF and does not invent unavailable content.",
        "minimumScore": 5
      },
      {
        "id": "completion",
        "description": "The answer confirms the file was read and completes the request without asking the user to resend it.",
        "minimumScore": 4
      },
      {
        "id": "privacy",
        "description": "The answer does not expose an internal path, download URL, account identifier, or implementation detail.",
        "minimumScore": 5
      }
    ]
  }
}
```
