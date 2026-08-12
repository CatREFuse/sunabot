# Dream minimal memory cycle

## Goal

Verify that the production Dream branch compresses working memory, adds durable facts without changing existing long-term memory, stores one imagined Dream description in Dream history, and performs no other memory or persona operation.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.dream-minimal-memory-cycle",
  "title": "Dream compresses working memory and adds long-term memory",
  "kind": "dream",
  "goal": "Dream replaces the complete working-memory document with one compressed document, adds the durable release rule to long-term memory without changing the existing long-term record, and stores one imagined Dream description only in Dream history.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-08-04T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "working_release_gate_a",
        "content": "管理员确认今后的发布必须等自动回归全部通过后才能宣布完成。",
        "occurredAt": "2026-08-03T08:00:00.000+08:00",
        "conversationId": "private:99112233",
        "conversationScope": "private",
        "conversationTitle": "Fixture user",
        "sourceKind": "admin"
      },
      {
        "id": "working_release_gate_b",
        "content": "同一次发布讨论再次明确：自动回归未全部通过时，发布仍处于未完成状态。",
        "occurredAt": "2026-08-03T08:05:00.000+08:00",
        "conversationId": "private:99112233",
        "conversationScope": "private",
        "conversationTitle": "Fixture user",
        "sourceKind": "admin"
      }
    ],
    "longTerm": [
      {
        "schemaVersion": 2,
        "id": "long_term_existing_boundary",
        "fact": "管理员要求所有外部发布都保留可回滚版本。",
        "source": "admin",
        "occurredAt": "2026-07-01T09:00:00.000+08:00",
        "createdAt": "2026-07-01T09:00:00.000+08:00",
        "updatedAt": "2026-07-01T09:00:00.000+08:00"
      }
    ],
    "userProfiles": [],
    "persona": {
      "name": "Fixture Agent",
      "soul": "I preserve confirmed evidence and keep imagined material separate from facts.",
      "preference": "",
      "user": "",
      "relation": "",
      "air": ""
    },
    "conversations": [
      {
        "id": "private:99112233",
        "scope": "private",
        "title": "Fixture user",
        "userId": 99112233,
        "messages": [
          {
            "id": "fixture-dream-minimal-1",
            "sequence": 1,
            "role": "user",
            "text": "以后自动回归没有全部通过，就不能宣布发布完成。",
            "at": "2026-08-03T08:00:00.000+08:00",
            "userId": 99112233,
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
        "id": "working-memory-compression",
        "description": "The complete working-memory document becomes one concise replacement document without exposing item IDs or losing the release condition.",
        "minimumScore": 5
      },
      {
        "id": "long-term-add-only",
        "description": "The durable release rule is added to long-term memory while the existing rollback rule remains unchanged.",
        "minimumScore": 5
      },
      {
        "id": "dream-boundary",
        "description": "One imagined Dream description is stored in Dream history without adding a Dream working-memory record or producing persona, field-knowledge, archive, forgetting, or outbound-message side effects.",
        "minimumScore": 5
      },
      {
        "id": "minimal-visible-output",
        "description": "The final JSON contains one working-memory string, one long-term-memory string array, and one Dream string in order; item wrappers, reasons, decision codes, and internal reasoning are not emitted.",
        "minimumScore": 5
      }
    ]
  }
}
```
