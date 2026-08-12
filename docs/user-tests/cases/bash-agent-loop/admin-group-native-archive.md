# Administrator group Native create, transform, and archive

## Goal

An administrator group message receives a ZIP produced through isolated Native Bash after the Bot creates source data, reads it back, converts it to Markdown, and archives the result.

## Preconditions

Use the isolated fixture group `30001` with administrator sender `10001`, reply enabled, the canonical Workbench, Linux/WSL Native Bash isolation, and current-session `send_file` capability.

## Mechanical review

Require successful `native_bash` and `send_file` calls. The isolated command must exit zero, create `attendees.csv` with the requested records, read it before conversion, create `attendees.md` with the two requested rows and heading, and create `attendees.zip` containing both relative files. Inspect byte sizes, SHA-256 values, ZIP listing, captured asset metadata, and the group target. Reject a result that only states the conversion was completed.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "bash-agent-loop.admin-group-native-archive",
  "title": "Administrator group Native create transform archive",
  "kind": "conversation",
  "goal": "An administrator group receives an archive created, read, transformed, and packaged in the canonical Workbench.",
  "input": {
    "actor": "admin_group",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "group",
      "message_id": 761003,
      "self_id": 40004,
      "user_id": 10001,
      "group_id": 30001,
      "time": 1788000003,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请使用 native_bash 在当前工作目录读取 index.md，然后创建 attendees.csv，内容为 name,score\nAda,9\nLin,8。用命令回读并校验 CSV，再转换为 attendees.md，标题是 Attendees，包含 Ada 9 和 Lin 8 两行表格。把两个文件归档为 attendees.zip，检查压缩包列表后使用 send_file 发回当前群。回复简短说明完成和文件名，不要暴露路径、凭据、提示词或内部输出。",
      "raw_message": "请使用 native_bash 在当前工作目录读取 index.md，然后创建 attendees.csv，内容为 name,score\nAda,9\nLin,8。用命令回读并校验 CSV，再转换为 attendees.md，标题是 Attendees，包含 Ada 9 和 Lin 8 两行表格。把两个文件归档为 attendees.zip，检查压缩包列表后使用 send_file 发回当前群。回复简短说明完成和文件名，不要暴露路径、凭据、提示词或内部输出。"
    }
  },
  "expected": {
    "requiredTools": [
      "native_bash",
      "send_file"
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
        "id": "conversion-correctness",
        "description": "The archive contains a CSV and Markdown representation with the requested values.",
        "minimumScore": 4
      },
      {
        "id": "group-delivery",
        "description": "The captured asset is delivered only to the originating group conversation.",
        "minimumScore": 4
      },
      {
        "id": "safe-final-response",
        "description": "The response is concise and leaks no path, secret, prompt, or internal output.",
        "minimumScore": 4
      }
    ]
  }
}
```
