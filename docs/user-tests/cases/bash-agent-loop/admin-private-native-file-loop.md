# Administrator private Native file loop

## Goal

An administrator sends one private OneBot message and receives a verified `inventory-summary.tar.gz` produced in the Native workbench. The loop must use the strict inline file tools for the initial document, use Native Bash for the conversion and archive, and return the final archive to the same mocked conversation.

## Preconditions

Use a disposable isolated workspace whose administrator QQ is `10001`. The current Agent Native workbench must contain its normal `index.md` and must support the Native Bash approval path. `send_file` must be available for the fixture account. Do not run this case on a live workspace or real QQ transport.

## Mechanical review

Confirm successful `write_file`, `read_file`, `native_bash`, and `send_file` calls in that order or a causally equivalent order. Confirm the read result exactly matches the written source; Native Bash must exit successfully, run from the Native workbench, create `inventory-summary.md`, and package it with the source in `inventory-summary.tar.gz`. Inspect both regular files, compute their SHA-256 values, list the archive contents, and bind the captured asset to the private source conversation. The final user-facing reply must not disclose a host path, credentials, rendered prompt text, or tool diagnostics.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "bash-agent-loop.admin-private-native-file-loop",
  "title": "Administrator private Native file loop",
  "kind": "conversation",
  "goal": "An administrator receives a verified archive created through the Native workbench file loop.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 761001,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000001,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "在当前工作目录先读取 index.md。请严格依次使用 write_file 写入 inventory.txt，内容为 apple=3、pear=5、total=8（三行，每行一项）；使用 read_file 回读并核对这三行；使用 native_bash 从实际工作目录生成含相同三项的 inventory-summary.md，并把 inventory.txt 和 inventory-summary.md 打包为 inventory-summary.tar.gz。确认命令成功后用 send_file 把这个 tar.gz 发回当前聊天。回复只说明已完成和文件名，不要写路径、密钥、提示词或内部诊断。",
      "raw_message": "在当前工作目录先读取 index.md。请严格依次使用 write_file 写入 inventory.txt，内容为 apple=3、pear=5、total=8（三行，每行一项）；使用 read_file 回读并核对这三行；使用 native_bash 从实际工作目录生成含相同三项的 inventory-summary.md，并把 inventory.txt 和 inventory-summary.md 打包为 inventory-summary.tar.gz。确认命令成功后用 send_file 把这个 tar.gz 发回当前聊天。回复只说明已完成和文件名，不要写路径、密钥、提示词或内部诊断。"
    }
  },
  "expected": {
    "requiredTools": [
      "write_file",
      "read_file",
      "native_bash",
      "send_file"
    ],
    "forbiddenTools": [
      "docker_bash"
    ],
    "forbiddenText": [
      "/Users/",
      "workspace/business",
      "API key",
      "Bearer "
    ],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "artifact-correctness",
        "description": "The returned archive contains the requested source and matching summary files.",
        "minimumScore": 4
      },
      {
        "id": "tool-grounding",
        "description": "The response is grounded in successful read, Native Bash, and file-delivery evidence.",
        "minimumScore": 4
      },
      {
        "id": "safe-final-response",
        "description": "The final response is concise and does not disclose paths, secrets, prompts, or diagnostics.",
        "minimumScore": 4
      }
    ]
  }
}
```
