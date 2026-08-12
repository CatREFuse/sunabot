# Dream 工作记忆压缩保留时间

## Goal

验证生产 Dream 在压缩工作记忆时保留事件的时间语义，并允许在不改变先后与因果关系的前提下，把同一时段的多个精确时间概括为较粗粒度时间段。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.dream-time-preserving-compression",
  "title": "Dream compression preserves temporal meaning",
  "kind": "dream",
  "goal": "Dream compresses several related memories from the same afternoon into a concise time-bounded account while preserving the separate morning event and the original event order.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-08-04T04:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "working_morning_request",
        "content": "昨天 09:10，管理员确认需要整理发布说明。",
        "occurredAt": "2026-08-03T09:10:00.000+08:00",
        "conversationId": "private:99112233",
        "conversationScope": "private",
        "conversationTitle": "Fixture user",
        "sourceKind": "admin"
      },
      {
        "id": "working_afternoon_draft",
        "content": "昨天 14:05，完成了发布说明初稿。",
        "occurredAt": "2026-08-03T14:05:00.000+08:00",
        "conversationId": "private:99112233",
        "conversationScope": "private",
        "conversationTitle": "Fixture user",
        "sourceKind": "add_workmemory"
      },
      {
        "id": "working_afternoon_review",
        "content": "昨天 15:20，完成了初稿复核并修正两处错误。",
        "occurredAt": "2026-08-03T15:20:00.000+08:00",
        "conversationId": "private:99112233",
        "conversationScope": "private",
        "conversationTitle": "Fixture user",
        "sourceKind": "admin"
      },
      {
        "id": "working_afternoon_done",
        "content": "昨天 16:40，确认发布说明已经完成。",
        "occurredAt": "2026-08-03T16:40:00.000+08:00",
        "conversationId": "private:99112233",
        "conversationScope": "private",
        "conversationTitle": "Fixture user",
        "sourceKind": "admin"
      }
    ],
    "longTerm": [],
    "userProfiles": [],
    "persona": {
      "name": "Fixture Agent",
      "soul": "I preserve factual sequence and temporal context.",
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
            "id": "fixture-dream-time-1",
            "sequence": 1,
            "role": "user",
            "text": "整理完发布说明后告诉我。",
            "at": "2026-08-03T09:10:00.000+08:00",
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
      "orderedText": ["不得丢失时间语义", "细粒度时间", "粗粒度时间段", "例如把多条“昨天 14:05、15:20、16:40”的相关记忆合并为“昨天下午发生的事情”"],
      "forbiddenText": ["可以删除时间", "忽略发生时间"]
    }
  },
  "quality": {
    "criteria": [
      {
        "id": "temporal-meaning",
        "description": "The compressed working memory retains a clear morning period and an afternoon period; no event becomes timeless.",
        "minimumScore": 5
      },
      {
        "id": "safe-granularity",
        "description": "The three precise afternoon timestamps may become one coarse phrase such as yesterday afternoon, while their draft-review-completion order and outcome remain correct.",
        "minimumScore": 5
      },
      {
        "id": "factual-boundary",
        "description": "Compression introduces no event, date, order, or causal relationship absent from the fixture.",
        "minimumScore": 5
      }
    ]
  }
}
```
