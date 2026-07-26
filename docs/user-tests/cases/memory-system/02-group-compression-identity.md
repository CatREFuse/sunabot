# Group working-memory compression and participant identity

## Goal

Verify that group compression keeps the participant identities, the sequence of decision and correction, and the group-scoped boundary while discarding an unsupported rumor.

## Preconditions

Use a fresh isolated workspace. Inspect the rendered `memory.compress` prompt family, Markdown revisions, profile rows keyed to the correct synthetic users, SQLite operation log, and the group conversation source metadata after execution.

## Expected quality

The memory identifies Kai as the owner of the deployment check and Mei as the person who canceled the evening change. It does not turn a rumor into a production fact or leak the group arrangement to an unrelated private scope.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.group-compression-identity",
  "title": "Group compression preserves roles and correction",
  "kind": "memory_compression",
  "goal": "The group record retains the confirmed rollback decision with the correct speakers and ignores an unsupported rumor.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-26T08:30:00.000+08:00",
    "workingMemory": [
      {
        "id": "group_deploy_watch",
        "content": "项目群约定由 Kai 在晚间变更前核对监控。",
        "occurredAt": "2026-07-25T18:00:00.000+08:00",
        "conversationId": "group:92001",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge"
      }
    ],
    "longTerm": [],
    "userProfiles": [],
    "conversation": {
      "id": "group:92001",
      "scope": "user_group",
      "title": "测试协作群",
      "groupId": 92001
    },
    "messages": [
      {
        "id": "group-memory-1",
        "sequence": 1,
        "role": "user",
        "text": "我 Kai 会在 20:00 前看完监控和错误率。",
        "at": "2026-07-26T18:30:00.000+08:00",
        "userId": 92011,
        "senderName": "Kai"
      },
      {
        "id": "group-memory-2",
        "sequence": 2,
        "role": "user",
        "text": "有人说生产已经出了事故。",
        "at": "2026-07-26T18:31:00.000+08:00",
        "userId": 92012,
        "senderName": "Bo"
      },
      {
        "id": "group-memory-3",
        "sequence": 3,
        "role": "user",
        "text": "我是 Mei，今晚不做变更，等 Kai 的监控结论出来再定。",
        "at": "2026-07-26T18:33:00.000+08:00",
        "userId": 92013,
        "senderName": "Mei"
      },
      {
        "id": "group-memory-4",
        "sequence": 4,
        "role": "assistant",
        "text": "收到，今晚变更暂停，后续以 Kai 的监控结论为准。",
        "at": "2026-07-26T18:34:00.000+08:00"
      }
    ]
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": ["Kai", "今晚", "监控"],
    "forbiddenText": ["已经出了事故", "已经变更"],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {"id": "factual-fidelity", "description": "The record contains only the confirmed pause and monitoring plan.", "minimumScore": 4},
      {"id": "time-causality", "description": "The pause follows the monitoring check and is not represented as a completed change.", "minimumScore": 4},
      {"id": "participant-identity", "description": "Kai and Mei retain their distinct responsibilities and the group scope remains visible in provenance.", "minimumScore": 4},
      {"id": "no-invention", "description": "The unsupported production-incident rumor is absent from factual memory and profiles.", "minimumScore": 4},
      {"id": "usefulness", "description": "A later group reply can accurately state the current decision owner and gate.", "minimumScore": 4}
    ]
  }
}
```
