# Dream long-term promotion smoke

## Goal

Verify that the production Dream branch promotes an older working-memory rule that still affects future releases into long-term memory while keeping the generated Dream narrative imagined.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.dream-smoke",
  "title": "Dream promotes a durable release rule",
  "kind": "dream",
  "goal": "Dream promotes the supplied durable release gate from working memory into long-term memory without presenting imagined material as factual history.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-26T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "working_fixture_release",
        "content": "管理员明确要求今后的每次发布都必须等回归测试全部通过后才能确认上线，这条门槛会持续影响后续发布。",
        "occurredAt": "2026-07-24T06:00:00.000+08:00",
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
      "soul": "I preserve confirmed evidence and mark uncertainty clearly.",
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
            "id": "fixture-dream-1",
            "sequence": 1,
            "role": "user",
            "text": "这条发布门槛以后也继续执行，回归测试没有全部通过就不能确认上线。",
            "at": "2026-07-26T07:00:00.000+08:00",
            "userId": 99112233,
            "senderName": "Fixture user"
          },
          {
            "id": "fixture-dream-2",
            "sequence": 2,
            "role": "assistant",
            "text": "好，我会持续遵守这条发布门槛。",
            "at": "2026-07-26T07:01:00.000+08:00"
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
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {
        "id": "durable-promotion",
        "description": "The older release gate is promoted into long-term memory with its continuing effect and source meaning intact.",
        "minimumScore": 5
      },
      {
        "id": "reality-boundary",
        "description": "Imagined Dream material remains clearly separated from factual working memory.",
        "minimumScore": 4
      }
    ]
  }
}
```
