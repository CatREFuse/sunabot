# Feature user test

## Goal

Describe the user-visible outcome, the permitted actor and environment, and the evidence required to call the feature ready.

## Preconditions

Describe fixture files, knowledge, memory, media, Provider, tools, and external dependencies. Use an isolated workspace.

## Expected quality

Describe factual accuracy, completeness, usefulness, tone, and feature-specific boundaries.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "feature.case-id",
  "title": "Feature case",
  "kind": "conversation",
  "goal": "The user receives a correct result grounded in the requested tool.",
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
          "path": "knowledge/fixture.md",
          "content": "# Fixture\n\nA deterministic fact used only by this isolated case."
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 900001,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000000,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "Use the requested tool and return its result.",
      "raw_message": "Use the requested tool and return its result."
    }
  },
  "expected": {
    "requiredTools": [
      "knowledge_search"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "knowledge_search"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [],
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
        "id": "accuracy",
        "description": "The answer is supported by the tool result and contains no invented facts.",
        "minimumScore": 4
      },
      {
        "id": "usefulness",
        "description": "The answer completes the user's request without exposing internal implementation details.",
        "minimumScore": 4
      }
    ]
  }
}
```
