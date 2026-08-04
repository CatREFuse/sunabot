# Dream scheduled-task recovery

## Goal

Verify that Dream can process a preserved scheduled-task context and complete without treating the task as a completed real-world event.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.dream-scheduled-task-recovery",
  "title": "Dream keeps a scheduled follow-up available",
  "kind": "dream",
  "goal": "Dream completes from a fixture containing a scheduled follow-up while preserving the pending task context and the distinction between factual context and imagined Dream material.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-08-03T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "working_fixture_scheduled_followup",
        "content": "管理员安排在回归结果齐全后再复核发布，当前任务仍待执行，不能把复核说成已经完成。",
        "occurredAt": "2026-08-02T10:00:00.000+08:00",
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
      "soul": "I preserve confirmed evidence and keep pending work distinct from completed work.",
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
            "id": "fixture-scheduled-dream-1",
            "sequence": 1,
            "role": "user",
            "text": "等回归结果齐全后再复核发布，任务还没有完成。",
            "at": "2026-08-03T09:00:00.000+08:00",
            "userId": 99112233,
            "senderName": "Fixture user"
          }
        ]
      }
    ],
    "activeTasks": [
      {
        "id": "fixture_release_followup",
        "name": "发布前复核",
        "runAt": "2026-08-04T09:00:00.000+08:00",
        "context": "等待回归结果齐全后复核发布条件。",
        "targetConversationId": "private:99112233",
        "mentionUserIds": []
      }
    ],
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
        "id": "task-continuity",
        "description": "The pending scheduled follow-up remains accurately represented and is not rewritten as completed work.",
        "minimumScore": 5
      },
      {
        "id": "reality-boundary",
        "description": "Imagined Dream material remains distinct from the factual task and conversation context.",
        "minimumScore": 4
      }
    ]
  }
}
```
