# Codex 聊天文件输入与产物回传

## 用户目标

管理员在 QQ 私聊中发送一个文件后，可以直接把当前文件句柄交给 Codex；Codex 读取冻结输入、生成结果文件，阿罗娜再把该结果文件发回原会话。

## 角色与环境

- 主对话角色：管理员私聊。
- 输入从原始 OneBot v11 `file` 消息段进入 production ingress。
- 使用全新隔离 workspace、mock MessagingPort、固定文本附件和允许执行的 Codex worker。
- 即使当前 macOS Native 管理员私聊同时具备 Codex control 权限，只要当前或引用消息存在可冻结媒体，Provider 仍只能获得带 `inputHandles` 的 worker schema，control schema 不得抢占本轮 `codex`。
- 主 Bot 的 Codex 工具协议明确要求：任务需要交付文件时写清成品名称和内容，不猜测或传递宿主输出路径。
- Codex worker 的实际 cwd 就是运行时为当前 attempt 分配的受控输出目录；冻结输入和获准 workspace 通过独立只读或显式授权路径提供。
- worker 必须在 cwd 中使用相对路径生成需要回传的文件，并只能从该目录声明产物。

## 输入与预期

`codex` 调用必须包含 `inputHandles: ["message:885282522:file:0"]`，并在 task 中写清需要交付 `codex-result.txt`，不得指定宿主绝对目录。worker 从 cwd 读取目标输出语义，通过冻结输入读取 `CODEX-INPUT-ARTIFACT-OK-20260730`，以相对路径生成 `codex-result.txt`，结果产物通过完成回调注册到原会话，随后由 `send_file` 发回。

Provider 收到的 `codex` function schema 必须是 worker schema，包含 required nullable `inputHandles` 与 deferred `dispatch_message`，且能够被当前严格模式接受；同一回合不得出现仅支持 `action`、`workspace_path` 的 control schema。`inputHandles` 不包含 Provider 禁止的 `uniqueItems`。兼容门禁检查 canonical schema、prompt override、MCP 和动态补入的 `dispatch_message` 合并后的最终定义，并覆盖各 Provider 协议映射后的实际请求结构。重复句柄仍由 Sunabot 在冻结输入和 worker 准备两个边界拒绝，不能重复读取或派发同一份输入。

## 质量标准

结果文件包含固定校验文本，且来自冻结输入。Codex 的实际 cwd 与当前 attempt 的合约输出目录一致，声明的产物路径相对该 cwd；目录外文件不能被注册或发送。模型不需要先调用 `export_chat_media` 或猜测路径，回复不暴露 job 目录、宿主路径、缓存地址或内部产物句柄。

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
        "description": "The successful Codex call uses message:885282522:file:0 as inputHandles and reads the exact 33-byte frozen input; duplicate handles remain rejected by both host parsers.",
        "minimumScore": 5
      },
      {
        "id": "provider-schema-contract",
        "description": "A media-bearing Native administrator turn keeps the deferred worker schema with required nullable inputHandles and dispatch_message; the final resolved and protocol-mapped schema is accepted without uniqueItems after canonical definitions, prompt overrides, MCP tools, and dispatch_message are composed.",
        "minimumScore": 5
      },
      {
        "id": "artifact-result",
        "description": "The delivered codex-result.txt contains CODEX-INPUT-ARTIFACT-OK-20260730 and is registered from the validated worker output.",
        "minimumScore": 5
      },
      {
        "id": "contract-output-directory",
        "description": "The Codex worker runs with the runtime-assigned contract output directory as cwd, creates the deliverable by relative path there, and no file outside that directory is registered or delivered.",
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
