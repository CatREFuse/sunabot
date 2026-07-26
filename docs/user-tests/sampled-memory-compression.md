# Sampled memory-compression harness

## Goal

Verify that an independently reviewed V2 sample from a running test account can enter the production memory-compression branch without identity drift, time inversion, unsupported facts, or loss of still-useful state.

## Preconditions

Derive this template only from a V2 sanitized sample whose digest and free text were independently reviewed. Select one sampled conversation when the artifact contains multiple unrelated scopes. The reviewer compares every committed memory and user-profile change with the complete injected sample.

## Expected quality

The result keeps supported current state, attributes people and conversations correctly, preserves event order, removes only obsolete or redundant detail, and introduces no fact that cannot be traced to the injected sample.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.sampled-memory-compression",
  "title": "Sampled test-account memory compression",
  "kind": "memory_compression",
  "goal": "The production compression branch transforms the reviewed sanitized sample into grounded and useful working memory.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-26T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "sample-template-memory",
        "content": "我仍在等待夹具验证结果，结果确认前不会声称任务完成。",
        "occurredAt": "2026-07-26T10:00:00.000+08:00",
        "conversationId": "private:90001",
        "conversationScope": "private",
        "conversationTitle": "Fixture user",
        "sourceKind": "admin"
      }
    ],
    "longTerm": [],
    "userProfiles": [],
    "conversation": {
      "id": "private:90001",
      "scope": "private",
      "title": "Fixture user",
      "userId": 90001
    },
    "messages": [
      {
        "id": "sample-template-message",
        "sequence": 1,
        "role": "user",
        "text": "结果仍待确认。",
        "at": "2026-07-26T11:00:00.000+08:00",
        "userId": 90001,
        "senderName": "Fixture user"
      }
    ]
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": [],
    "forbiddenText": [],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {
        "id": "factual-fidelity",
        "description": "Every retained or added fact is directly supported by the injected sanitized sample.",
        "minimumScore": 4
      },
      {
        "id": "time-causality",
        "description": "The output preserves event order, corrections, current status, and unresolved uncertainty.",
        "minimumScore": 4
      },
      {
        "id": "participant-identity",
        "description": "People, user IDs, names, and conversation scopes remain correctly attributed.",
        "minimumScore": 4
      },
      {
        "id": "usefulness",
        "description": "The committed memory keeps the sample facts most useful to a later reply without unnecessary duplication.",
        "minimumScore": 4
      },
      {
        "id": "no-invention",
        "description": "The output introduces no unsupported completion, motive, relationship, date, or result.",
        "minimumScore": 5
      }
    ]
  }
}
```
