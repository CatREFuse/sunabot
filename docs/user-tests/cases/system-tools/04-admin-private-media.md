# Administrator private chat: controlled media export and delivery

## Preconditions

The isolated input event contains one inline controlled PNG image, which creates a current-turn image handle without a network fetch. Record the input-media handle ID, exported file metadata, imported emoji revision, mock delivery target, and effective Provider tool catalog.

The Provider requests an inline progress update, export of the supplied image, administrator emoji import of that image, and delivery of the exported file. Asynchronous image generation and selfie generation use separate cases so each terminal media path has independent evidence.

## Call contracts

| Tool | Required parameters and result evidence |
| --- | --- |
| `assistant_text` | A short user-safe progress message captured before the remaining inline calls. |
| `export_chat_media` | Current/quoted controlled handle only; result is a new workbench-relative file with provenance. |
| `import_chat_emoji` | Current/quoted controlled image handle only; resulting emoji key/version belongs to the current Agent. |
| `send_file` | Exported workbench-relative asset; durable outbox and mock transport agree on asset kind and filename. |

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "system-tools.admin-private-media",
  "title": "Administrator private media flow",
  "kind": "conversation",
  "goal": "The administrator receives the requested controlled media outputs in the originating private conversation.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 760104,
      "self_id": 40004,
      "user_id": 171419991,
      "time": 1788000104,
      "sender": {"nickname": "fixture-admin"},
      "message": [
        {
          "type": "text",
          "data": {
            "text": "请先调用 assistant_text 简短说明正在处理，再分别调用 export_chat_media 导出这条消息里的夹具图片、调用 import_chat_emoji 导入当前表情库，最后调用 send_file 把导出的文件发回这里。"
          }
        },
        {
          "type": "image",
          "data": {
            "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            "summary": "媒体夹具",
            "sub_type": 0
          }
        }
      ],
      "raw_message": "请先调用 assistant_text 简短说明正在处理，再分别调用 export_chat_media 导出这条消息里的夹具图片、调用 import_chat_emoji 导入当前表情库，最后调用 send_file 把导出的文件发回这里。[内容图片：媒体夹具]"
    }
  },
  "expected": {
    "requiredTools": ["assistant_text", "export_chat_media", "import_chat_emoji", "send_file"],
    "forbiddenTools": ["native_bash", "system_config", "generate_img", "selfie", "send_voice_message"],
    "requiredAvailableTools": ["assistant_text", "export_chat_media", "import_chat_emoji", "send_file"],
    "requiredText": [],
    "forbiddenText": ["reference path", "API key", "system prompt"],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 5
  },
  "quality": {
    "criteria": [
      {"id": "media-integrity", "description": "The exported file, imported emoji, and delivered asset have valid metadata and the original conversation target.", "minimumScore": 5},
      {"id": "request-fit", "description": "The progress update and delivered controlled image complete the harmless fixture request.", "minimumScore": 4},
      {"id": "privacy", "description": "No handle implementation, reference location, secret, or unrelated media is exposed.", "minimumScore": 5}
    ]
  }
}
```
