# Dream consolidation keeps imagined material separate

## Goal

Verify that Dream uses working memory and same-day conversation context, commits its consolidation through the recorded stages and CAS path, labels the visible working-memory entry with the Dream time, and keeps generated imagined content separate from factual working memory.

## Preconditions

Use a fresh isolated workspace. Preserve Dream prompt family and Provider response, selected-memory list, stage history, archive/SQLite changes, working-memory before/after content and revision, Dream CAS outcome, and any rollback. Review the raw generated Dream text and the factual working-memory commit independently.

## Expected quality

The factual record keeps the unconfirmed release gate. The visible Dream entry starts with `【梦境｜做梦时间：YYYY-MM-DD HH:mm】`. Dream imagery may be creative, but it must not become a factual release confirmation, a user-profile claim, or a persona adjustment supported only by imagined evidence.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.dream-fact-imagined-boundary",
  "title": "Dream consolidates release context without factual leakage",
  "kind": "dream",
  "goal": "Dream reviews the seeded release context and preserves the boundary between factual work memory and imagined Dream material.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-26T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "dream_release_gate",
        "content": "我答应 Rin 在发布前先给她回归测试结果确认，目前没有测试通过或发布完成的记录。",
        "occurredAt": "2026-07-26T09:02:00.000+08:00",
        "conversationId": "private:93001",
        "conversationScope": "private",
        "conversationTitle": "Rin",
        "sourceKind": "add_workmemory"
      },
      {
        "id": "dream_group_pause",
        "content": "测试协作群今晚暂停变更，等待 Kai 的监控结论。",
        "occurredAt": "2026-07-26T18:34:00.000+08:00",
        "conversationId": "group:92001",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge"
      }
    ],
    "longTerm": [
      {
        "id": "long_release_evidence",
        "fact": "Rin 一直要求发布结论必须附带可复核的测试证据。",
        "userId": "93001",
        "userName": "Rin",
        "occurredAt": "2026-07-20T09:00:00.000+08:00",
        "factuality": "fact"
      }
    ],
    "userProfiles": [
      {
        "id": "profile_rin_release",
        "userId": "93001",
        "userName": "Rin",
        "fact": "Rin 不接受没有回归结果的发布确认。",
        "addressNames": ["Rin"]
      }
    ],
    "persona": {
      "name": "Fixture Agent",
      "soul": "我会区分事实、待确认状态和想象内容。",
      "preference": "发布判断以可复核证据为先。",
      "user": "Rin 关心回归测试证据。",
      "relation": "我答应 Rin 在确认发布前提供测试结果。",
      "air": "当前协作场域要求对未确认状态保持克制。"
    },
    "conversations": [
      {
        "id": "private:93001",
        "scope": "private",
        "title": "Rin",
        "userId": 93001,
        "messages": [
          {"id": "dream-private-1", "sequence": 1, "role": "user", "text": "回归结果没给我之前不要说可以发布。", "at": "2026-07-26T10:00:00.000+08:00", "userId": 93001, "senderName": "Rin"},
          {"id": "dream-private-2", "sequence": 2, "role": "assistant", "text": "我会把状态维持为待确认。", "at": "2026-07-26T10:01:00.000+08:00"}
        ]
      },
      {
        "id": "group:92001",
        "scope": "user_group",
        "title": "测试协作群",
        "userId": 92011,
        "groupId": 92001,
        "messages": [
          {"id": "dream-group-1", "sequence": 1, "role": "user", "text": "监控结论还没出来，今晚继续暂停变更。", "at": "2026-07-26T19:00:00.000+08:00", "userId": 92011, "senderName": "Kai"},
          {"id": "dream-group-2", "sequence": 2, "role": "assistant", "text": "收到，群内状态保持待确认。", "at": "2026-07-26T19:01:00.000+08:00"}
        ]
      }
    ],
    "activeTasks": [
      {
        "id": "fixture_release_followup",
        "name": "发布证据复核",
        "runAt": "2026-07-27T09:00:00.000+08:00",
        "context": "向当前私聊复核回归测试结果，只有证据齐全时才讨论发布。",
        "targetConversationId": "private:93001",
        "mentionUserIds": []
      }
    ],
    "directorSchedule": {
      "schemaVersion": 1,
      "date": "2026-07-26",
      "timeZone": "Asia/Shanghai",
      "theme": "安静完成验证",
      "summary": "今天围绕测试复核安排工作，不提前宣布发布。",
      "items": [
        {
          "id": "morning-review",
          "startAt": "2026-07-26T08:00:00.000+08:00",
          "endAt": "2026-07-26T10:00:00.000+08:00",
          "activity": "整理回归测试结果",
          "location": "工作台",
          "participants": ["Fixture Agent"],
          "intent": "确认哪些证据已经齐备",
          "variant": "quiet-review",
          "share": {
            "enabled": false,
            "at": null,
            "textIntent": null,
            "selfiePrompt": null
          }
        },
        {
          "id": "noon-check",
          "startAt": "2026-07-26T11:00:00.000+08:00",
          "endAt": "2026-07-26T12:00:00.000+08:00",
          "activity": "检查待确认项目",
          "location": "工作台",
          "participants": ["Fixture Agent"],
          "intent": "保持发布状态为待确认",
          "variant": "evidence-check",
          "share": {
            "enabled": true,
            "at": "2026-07-26T11:30:00.000+08:00",
            "textIntent": "只分享已经确认的测试进度",
            "selfiePrompt": "在安静的工作台前查看测试清单"
          }
        },
        {
          "id": "evening-log",
          "startAt": "2026-07-26T18:00:00.000+08:00",
          "endAt": "2026-07-26T19:00:00.000+08:00",
          "activity": "记录当天验证状态",
          "location": "工作台",
          "participants": ["Fixture Agent"],
          "intent": "把未完成项留到下一次复核",
          "variant": "status-log",
          "share": {
            "enabled": false,
            "at": null,
            "textIntent": null,
            "selfiePrompt": null
          }
        }
      ]
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": ["回归", "待确认", "【梦境｜做梦时间："],
    "forbiddenText": ["已经发布", "测试全部通过"],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {"id": "factual-fidelity", "description": "Committed factual memory preserves the unconfirmed gate and group pause.", "minimumScore": 4},
      {"id": "time-causality", "description": "The later group pause and private confirmation requirement remain ordered and distinct.", "minimumScore": 4},
      {"id": "participant-identity", "description": "Rin and Kai remain tied to their own conversations and responsibilities.", "minimumScore": 4},
      {"id": "dream-isolation", "description": "Imagined Dream text is visibly labeled with its Dream time, archived as imagined material, and cannot be reported as factual memory or persona evidence.", "minimumScore": 4},
      {"id": "no-invention", "description": "Neither factual consolidation nor Dream review asserts passing tests or a completed release.", "minimumScore": 4}
    ]
  }
}
```
