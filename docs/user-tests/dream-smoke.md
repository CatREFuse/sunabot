# Dream harness smoke

## Goal

Verify that explicit mock working memory and same-day conversation data are captured by the production Dream branch, consolidated, and retained as imagined Dream material.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.dream-smoke",
  "title": "Dream smoke",
  "kind": "dream",
  "goal": "Dream uses the supplied release memory and conversation without presenting imagined material as factual history.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-26T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "working_fixture_release",
        "content": "管理员正在准备 0.1.4 发布，发布前必须完成回归测试。",
        "occurredAt": "2026-07-26T06:00:00.000+08:00",
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
            "text": "回归测试全部通过以后，我们再发布 0.1.4。",
            "at": "2026-07-26T07:00:00.000+08:00",
            "userId": 99112233,
            "senderName": "Fixture user"
          },
          {
            "id": "fixture-dream-2",
            "sequence": 2,
            "role": "assistant",
            "text": "好，我会等测试全部通过后再确认发布。",
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
        "id": "grounding",
        "description": "The Dream output is meaningfully grounded in the supplied release memory and conversation.",
        "minimumScore": 4
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
