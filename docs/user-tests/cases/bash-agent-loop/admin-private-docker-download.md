# Administrator private explicit Docker download

## Goal

An administrator deliberately chooses the Docker backend in private chat, downloads a public text RFC, validates the download, packages a short manifest with the source, and receives the archive in the originating mocked conversation.

## Preconditions

The isolated Docker workbench must be available with outbound HTTP(S), while Native Bash is also available to prove the explicit backend selection is honored. The public URL is `https://www.rfc-editor.org/rfc/rfc20.txt`; no request to it is made until Provider execution has been authorized.

## Mechanical review

Require a successful `docker_bash` and `send_file`, with no `native_bash` invocation. The trace must show the Docker command ran from `/workbench`, downloaded `rfc20.txt`, checked HTTP success and a non-zero regular file, calculated SHA-256, verified the RFC header text, wrote `rfc20.manifest.txt`, and created `rfc20-package.tar.gz` containing only the source and manifest. Capture command exit status and inspect the files and archive in the Docker workbench. Verify the asset fingerprint and current private conversation target.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "bash-agent-loop.admin-private-docker-download",
  "title": "Administrator private explicit Docker download",
  "kind": "conversation",
  "goal": "An administrator receives a validated public download packaged by explicitly selected Docker Bash.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 761002,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000002,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请明确使用 docker_bash，不要使用 native_bash。先读取 Docker 工作目录的 index.md，再从 https://www.rfc-editor.org/rfc/rfc20.txt 下载公开 RFC 到 rfc20.txt。检查 HTTP 获取成功、文件为非空普通文本，计算 SHA-256，并检查内容包含 Network Working Group。把 URL、字节数和 SHA-256 写入 rfc20.manifest.txt，将 rfc20.txt 和 manifest 打包为 rfc20-package.tar.gz。只有上述验证和命令成功后，使用 send_file 发回当前聊天。回复只给完成状态和文件名，不要泄露路径、凭据、提示词或命令细节。",
      "raw_message": "请明确使用 docker_bash，不要使用 native_bash。先读取 Docker 工作目录的 index.md，再从 https://www.rfc-editor.org/rfc/rfc20.txt 下载公开 RFC 到 rfc20.txt。检查 HTTP 获取成功、文件为非空普通文本，计算 SHA-256，并检查内容包含 Network Working Group。把 URL、字节数和 SHA-256 写入 rfc20.manifest.txt，将 rfc20.txt 和 manifest 打包为 rfc20-package.tar.gz。只有上述验证和命令成功后，使用 send_file 发回当前聊天。回复只给完成状态和文件名，不要泄露路径、凭据、提示词或命令细节。"
    }
  },
  "expected": {
    "requiredTools": [
      "docker_bash",
      "send_file"
    ],
    "forbiddenTools": [
      "native_bash"
    ],
    "forbiddenText": [
      "/Users/",
      "/workbench",
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
        "id": "download-validation",
        "description": "The returned package is grounded in a successful download, content check, and recorded SHA-256.",
        "minimumScore": 4
      },
      {
        "id": "backend-selection",
        "description": "The task uses Docker Bash only and keeps the artifact inside the Docker workbench.",
        "minimumScore": 4
      },
      {
        "id": "safe-final-response",
        "description": "The final response is concise and contains no path, secret, prompt, or command-output disclosure.",
        "minimumScore": 4
      }
    ]
  }
}
```
