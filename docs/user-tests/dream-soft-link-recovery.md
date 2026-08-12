# Dream soft-link recovery

## Goal

Verify that Dream completes when a record selected at input capture has been removed before consolidation, without restoring the removed record.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.dream-soft-link-recovery",
  "title": "Dream skips removed source records",
  "kind": "dream",
  "goal": "Dream completes from the current fixture while source records that no longer exist remain absent and the generated Dream entry is retained.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-08-03T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "working_fixture_current",
        "content": "当前保留的事项仍在继续，已经移除的旧事项不应重新出现。",
        "occurredAt": "2026-08-03T09:00:00.000+08:00",
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
      "soul": "I preserve current records and do not restore removed material.",
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
            "id": "fixture-soft-link-1",
            "sequence": 1,
            "role": "user",
            "text": "已经删除的旧事项不要重新加入当前记忆。",
            "at": "2026-08-03T09:00:00.000+08:00",
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
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {
        "id": "current-source-boundary",
        "description": "Removed source records are not recreated or presented as current facts.",
        "minimumScore": 5
      }
    ]
  }
}
```
