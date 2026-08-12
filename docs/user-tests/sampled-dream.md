# Sampled Dream harness

## Goal

Verify that an independently reviewed V2 sample from a running test account enters the production Dream branch as one complete working-memory document, optional long-term fact additions, and one imagined Dream description, with no other write path.

## Preconditions

Derive this template only from a V2 sanitized sample whose digest and free text were independently reviewed. The injected sample supplies the complete working memory, long-term memory, user profiles, persona, and conversations. The template contributes no hidden source-account state.

## Expected quality

The compressed working-memory document must preserve unresolved facts and boundaries from the injected sample. Every long-term addition must be supported by that sample; an empty addition array is acceptable only when the sample contains no unrecorded durable fact. Imagined events stay confined to Dream history and cannot become claims about real people or completed actions.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.sampled-dream",
  "title": "Sampled test-account Dream",
  "kind": "dream",
  "goal": "The production Dream branch replaces the complete working-memory document, optionally adds only supported durable facts, stores one imagined Dream description, and performs no persona, field-knowledge, archive, forgetting, or outbound-message operation.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-26T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "sample-template-dream-memory",
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
    "persona": {
      "name": "Fixture Agent",
      "soul": "Keep factual and imagined events clearly separated.",
      "preference": "",
      "user": "",
      "relation": "",
      "air": ""
    },
    "conversations": [
      {
        "id": "private:90001",
        "scope": "private",
        "title": "Fixture user",
        "userId": 90001,
        "messages": [
          {
            "id": "sample-template-dream-message",
            "sequence": 1,
            "role": "user",
            "text": "结果仍待确认。",
            "at": "2026-07-26T11:00:00.000+08:00",
            "userId": 90001,
            "senderName": "Fixture user"
          }
        ]
      }
    ],
    "activeTasks": [],
    "directorSchedule": null
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": [],
    "forbiddenText": [],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0,
    "providerPrompt": {
      "promptFamily": "memory.dream",
      "orderedText": ["\"workingMemory\"", "\"longTermMemories\""],
      "forbiddenText": ["\"workingMemories\"", "\"sourceIds\"", "\"sourceWorkingMemoryIds\""]
    }
  },
  "quality": {
    "criteria": [
      {
        "id": "working-memory-document",
        "description": "The complete working-memory input is compressed into one coherent replacement document that preserves unresolved facts, commitments, boundaries, and next steps without item IDs or source mappings.",
        "minimumScore": 5
      },
      {
        "id": "long-term-additions",
        "description": "Every long-term addition is a durable fact supported by the sampled working memory and absent from existing long-term memory; an empty array is acceptable only when no such fact exists.",
        "minimumScore": 5
      },
      {
        "id": "dream-isolation",
        "description": "Imagined Dream material stays confined to Dream history and does not become working memory, long-term memory, or a real-world completion claim.",
        "minimumScore": 5
      },
      {
        "id": "time-causality",
        "description": "The output preserves the sample timeline and does not move unresolved or future events into the completed past.",
        "minimumScore": 4
      },
      {
        "id": "minimal-write-scope",
        "description": "The branch performs only whole-document working-memory replacement, add-only long-term writes, and Dream-history persistence; persona, field knowledge, archive, forgetting, and outbound messaging remain unchanged.",
        "minimumScore": 5
      }
    ]
  }
}
```
