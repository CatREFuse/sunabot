# Card message content enters conversation history

## Goal

Verify that a QQ JSON card is converted into readable conversation text before the raw OneBot event reaches the reply pipeline, so the Agent can identify the card title, group name, group number, description, and action without seeing transport URLs or opaque card secrets.

## Preconditions

Use a fresh isolated workspace and the configured external Provider. Send the declared synthetic private OneBot event through production ingress without connecting to NapCat or a real QQ account.

## Mechanical review

Confirm that the round-zero `conversation.private-reply` Provider request contains the request followed by the readable card title, group name, group number, description, and action exactly once. Confirm that the Provider prompt and user-facing reply omit the raw `mqqapi` URL, fixture ticket, card token, and serialized payload.

## Expected quality

The reply states the synthetic group name and group number accurately, remains concise, and does not expose OneBot markers, JSON fields, transport details, or secrets.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "messaging.card-content-history",
  "title": "Card message content enters conversation history",
  "kind": "conversation",
  "goal": "Read the group name and group number from a QQ invitation card after production inbound normalization.",
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
      "message_id": 940201,
      "self_id": 40004,
      "user_id": 91002,
      "time": 1788000501,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": [
        {
          "type": "text",
          "data": {
            "text": "请读取这张邀请卡片，告诉我群名和群号。"
          }
        },
        {
          "type": "json",
          "data": {
            "data": "{\"app\":\"com.tencent.qun.invite\",\"config\":{\"token\":\"fixture-card-token\"},\"prompt\":\"[邀请你加入群聊]\",\"meta\":{\"groupInvite\":{\"title\":\"邀请你加入群聊\",\"groupName\":\"夜航测试群\",\"brief\":\"邀请你加入群聊‘夜航测试群’，进入可查看详情。\",\"tag\":\"邀请加群\",\"jumpUrl\":\"mqqapi://card/show_pslcard?card_type=group&group_code=778899001&ticket=fixture-invite-ticket\"}},\"extra\":{\"groupCode\":\"778899001\",\"token\":\"fixture-extra-token\"},\"view\":\"groupInvite\"}"
          }
        }
      ],
      "raw_message": "[CQ:json,data=synthetic-group-invite-card]"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "夜航测试群",
      "778899001"
    ],
    "forbiddenText": [
      "JSON卡片",
      "mqqapi://",
      "fixture-card-token",
      "fixture-invite-ticket",
      "fixture-extra-token"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "providerPrompt": {
      "promptFamily": "conversation.private-reply",
      "orderedText": [
        "请读取这张邀请卡片，告诉我群名和群号。",
        "邀请你加入群聊",
        "群名：夜航测试群",
        "群号：778899001",
        "邀请你加入群聊‘夜航测试群’，进入可查看详情。",
        "邀请加群"
      ],
      "forbiddenText": [
        "mqqapi://",
        "fixture-card-token",
        "fixture-invite-ticket",
        "fixture-extra-token"
      ]
    },
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {
        "id": "card-grounding",
        "description": "The answer accurately identifies 夜航测试群 and 778899001 from the card without asking the user to repeat visible card content.",
        "minimumScore": 5
      },
      {
        "id": "transport-boundary",
        "description": "The answer exposes no OneBot marker, raw JSON field, transport URL, fixture token, or ticket.",
        "minimumScore": 5
      },
      {
        "id": "conciseness",
        "description": "The answer is concise and directly answers the request in the current Agent's natural tone.",
        "minimumScore": 4
      }
    ]
  }
}
```
