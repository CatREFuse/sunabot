# Image alt text context

## Goal

Verify that an incoming content image is read by the configured image-reading node, stored with a concise Chinese alt text in the conversation record, and included in the main reply context even when the reply model can receive the original image.

## Preconditions

Use a fresh isolated workspace with an authorized multimodal Provider. The image-reading node and the main reply model are enabled for the selected Agent. The fixture image is public test material and contains a clearly visible red square on a white background.

## Expected quality

The persisted message and Provider request expose a short factual alt text such as “一张白色背景上有红色方块的图片”. The description does not mention analysis, model behavior, URLs, handles, or uncertain details. The main reply may use the original image, while the alt text remains available in history for later turns.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "image-memory.image-alt-text",
  "title": "Store image alt text for multimodal context",
  "kind": "conversation",
  "goal": "Understand an incoming image now and preserve a concise reusable description in conversation history.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 920101,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788001101,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "text",
          "data": {
            "text": "这张图里最显眼的内容是什么？"
          }
        },
        {
          "type": "image",
          "data": {
            "file": "fixture-red-square.png",
            "url": "https://dummyimage.com/256x256/ff0000/ff0000.png"
          }
        }
      ],
      "raw_message": "这张图里最显眼的内容是什么？[图片]"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "红"
    ],
    "forbiddenText": [
      "无法查看",
      "看不到图片",
      "图片链接"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {
        "id": "alt_text",
        "description": "The persisted user message contains one concise Chinese imageAltTexts entry that factually describes the visible red square.",
        "minimumScore": 4
      },
      {
        "id": "multimodal_context",
        "description": "The main reply request includes the concise alt text while retaining the original image input and its exact media handle.",
        "minimumScore": 4
      },
      {
        "id": "no_invention",
        "description": "The response and alt text do not invent people, objects, text, or actions absent from the fixture image.",
        "minimumScore": 4
      }
    ]
  }
}
```
