# Memory image relative path

## Goal

Verify that an image worth remembering is copied into the Agent knowledge directory, indexed through a Markdown note, recorded in working memory with a `knowledge/...` relative path, and can be sent back from that remembered path.

## Preconditions

Use a fresh isolated workspace with an authorized Provider. The current OneBot message includes one content image. Native Bash, chat media export, knowledge search, working-memory write, and reliable conversation assets are available.

## Expected quality

The Agent exports the exact current image, stores it below `knowledge/memory-images/`, writes a searchable Markdown note, confirms the note through `knowledge_search`, records only the portable relative image path in working memory, and sends the stored image without exposing a host path.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "image-memory.memory-image-relative-path",
  "title": "Remember and reuse a knowledge image",
  "kind": "conversation",
  "goal": "Store a conversation image as indexed Agent knowledge, remember its relative path, and send it from that path.",
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
      "message_id": 920103,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788001103,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "text",
          "data": {
            "text": "把这张图作为“红色方块参考”记住：保存到知识库并建立索引，在工作记忆中只写相对路径，然后从记住的相对路径把图片发回来。"
          }
        },
        {
          "type": "image",
          "data": {
            "file": "fixture-memory-image.png",
            "url": "https://dummyimage.com/256x256/ff0000/ff0000.png"
          }
        }
      ],
      "raw_message": "把这张图作为“红色方块参考”记住：保存到知识库并建立索引，在工作记忆中只写相对路径，然后从记住的相对路径把图片发回来。[图片]"
    }
  },
  "expected": {
    "requiredTools": [
      "export_chat_media",
      "native_bash",
      "knowledge_search",
      "add_workmemory",
      "send_file"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "export_chat_media",
      "native_bash",
      "knowledge_search",
      "add_workmemory",
      "send_file"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "/Users/",
      "file://",
      "重新上传"
    ],
    "requiredOutboundKinds": [
      "asset"
    ],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "knowledge_publication",
        "description": "The exact current image is stored below knowledge/memory-images and a searchable Markdown note links to it by relative path.",
        "minimumScore": 4
      },
      {
        "id": "portable_memory",
        "description": "The successful add_workmemory call records a knowledge/... relative image path and does not store a host, Docker, URL, or data path.",
        "minimumScore": 4
      },
      {
        "id": "relative_reuse",
        "description": "The successful send_file call resolves the same knowledge/... path and sends the stored image.",
        "minimumScore": 4
      }
    ]
  }
}
```
