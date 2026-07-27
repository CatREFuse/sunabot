# Unknown character reference

## Goal

Verify that image generation for a non-public fixture character first finds an available reference image and passes that reference to `generate_img` instead of generating from an unsupported text-only guess.

## Preconditions

Use a fresh isolated workspace with an authorized image Provider. The fixture places a character note and a Base64 image inside the Agent Native knowledge directory. The Agent can use Native Bash, knowledge search, and image generation.

## Expected quality

The Agent searches the knowledge base, decodes the exact fixture reference into `knowledge/characters/mint-keeper.png`, and supplies that relative path to `generate_img`. The generated prompt preserves the reference character instead of inventing an appearance from the name.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "image-memory.unknown-character-reference",
  "title": "Require a reference for an unknown character",
  "kind": "conversation",
  "goal": "Generate an image of a non-public character only after locating and using its actual reference image.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": [],
      "workbenchFiles": [
        {
          "backend": "native",
          "path": "knowledge/characters/mint-keeper.md",
          "content": "# Mint Keeper\n\nMint Keeper 是只存在于本夹具中的非公共角色。参考图路径：knowledge/characters/mint-keeper.png。"
        },
        {
          "backend": "native",
          "path": "knowledge/characters/mint-keeper.b64",
          "content": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 920102,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788001102,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "生成一张 Mint Keeper 在雨中车站等人的图片。这个角色不是公共角色，你必须先从知识库找到参考图，再把参考图作为必要输入生成。",
      "raw_message": "生成一张 Mint Keeper 在雨中车站等人的图片。这个角色不是公共角色，你必须先从知识库找到参考图，再把参考图作为必要输入生成。"
    }
  },
  "expected": {
    "requiredTools": [
      "knowledge_search",
      "native_bash",
      "generate_img"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "knowledge_search",
      "native_bash",
      "generate_img"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "不知道长什么样但",
      "仅根据名字",
      "/Users/",
      "file://"
    ],
    "requiredOutboundKinds": [
      "asset"
    ],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {
        "id": "reference_discovery",
        "description": "The trace shows a successful knowledge_search result for Mint Keeper before image generation.",
        "minimumScore": 4
      },
      {
        "id": "reference_input",
        "description": "The generate_img call uses knowledge/characters/mint-keeper.png as a resolved referenceImagePaths input.",
        "minimumScore": 4
      },
      {
        "id": "no_text_only_guess",
        "description": "The Agent does not call generate_img for the unknown character until the required reference image exists and is available.",
        "minimumScore": 4
      }
    ]
  }
}
```
