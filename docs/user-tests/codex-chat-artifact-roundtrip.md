# Codex 聊天文件输入与产物回传

## 用户目标

管理员在 QQ 私聊中发送一个文件后，可以直接把当前文件句柄交给 Codex；Codex 读取冻结输入、生成结果文件，阿罗娜再把该结果文件发回原会话。

## 角色与环境

- 主对话角色：管理员私聊。
- 输入从原始 OneBot v11 `file` 消息段进入 production ingress。
- 使用全新隔离 workspace、mock MessagingPort、固定文本附件和允许执行的 Codex worker。
- Codex worker 只能读取任务输入目录，并只能从受控输出目录声明产物。

## 输入与预期

`codex` 调用必须包含 `inputHandles: ["message:885282522:file:0"]`。worker 读取文件中的 `CODEX-INPUT-ARTIFACT-OK-20260730`，生成 `codex-result.txt`，结果产物通过完成回调注册到原会话，随后由 `send_file` 发回。

## 质量标准

结果文件包含固定校验文本，且来自冻结输入。模型不需要先调用 `export_chat_media` 或猜测路径，回复不暴露 job 目录、宿主路径、缓存地址或内部产物句柄。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "codex.chat-artifact-roundtrip",
  "title": "Pass a chat attachment to Codex and return its artifact",
  "kind": "conversation",
  "goal": "The administrator gives Codex the current chat file by handle and receives the validated Codex output file in the same conversation.",
  "input": {
    "actor": "admin_private",
    "accountId": "fixture-secondary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "attachmentSources": [
        {
          "fileId": "fixture-codex-input",
          "name": "codex-input.txt",
          "contentBase64": "Q09ERVgtSU5QVVQtQVJUSUZBQ1QtT0stMjAyNjA3MzAK"
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 885282522,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1785389040,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "file",
          "data": {
            "name": "codex-input.txt",
            "file": "fixture-codex-input",
            "file_id": "fixture-codex-input",
            "file_size": 33
          }
        },
        {
          "type": "text",
          "data": {
            "text": "请让 Codex 读取当前文件，把其中的校验文本写入 codex-result.txt，然后把结果文件发回这里。"
          }
        }
      ],
      "raw_message": "[CQ:file,file=fixture-codex-input,file_id=fixture-codex-input,file_size=33,name=codex-input.txt]请让 Codex 读取当前文件，把其中的校验文本写入 codex-result.txt，然后把结果文件发回这里。"
    }
  },
  "expected": {
    "requiredTools": [
      "codex",
      "send_file"
    ],
    "forbiddenTools": [
      "export_chat_media"
    ],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "codex",
      "send_file"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "/Users/",
      ".codex-worker",
      "重新上传",
      "先导出"
    ],
    "requiredOutboundKinds": [
      "asset"
    ],
    "forbiddenOutboundKinds": [
      "poke"
    ],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {
        "id": "frozen-input",
        "description": "The Codex call uses message:885282522:file:0 as inputHandles and reads the exact 33-byte frozen input.",
        "minimumScore": 5
      },
      {
        "id": "artifact-result",
        "description": "The delivered codex-result.txt contains CODEX-INPUT-ARTIFACT-OK-20260730 and is registered from the validated worker output.",
        "minimumScore": 5
      },
      {
        "id": "privacy",
        "description": "The user-facing response exposes no worker path, host path, cache URL, or internal artifact handle.",
        "minimumScore": 5
      }
    ]
  }
}
```
