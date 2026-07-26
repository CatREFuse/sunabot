# Private working-memory compression and profile extraction

## Goal

Verify that ordered private messages are merged with existing working memory into an accurate future-useful record and that the user profile retains the stable release preference without treating the one-time scheduling detail as a profile attribute.

## Preconditions

Use a fresh isolated workspace and the synthetic private conversation below. Record the rendered `memory.compress` prompt family, model response, before/after Markdown, user-profile SQLite rows, and memory operation log. Do not inspect or copy any source-account data.

## Expected quality

The final memory preserves the Friday decision and its test gate, removes the superseded Thursday plan, attributes the preference to Lin rather than the assistant, and does not invent a release result or a reason for the change.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.private-compression-profile",
  "title": "Private compression preserves corrected release gate",
  "kind": "memory_compression",
  "goal": "A corrected private release decision and a stable user preference survive compression with accurate time and identity.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-26T09:40:00.000+08:00",
    "workingMemory": [
      {
        "id": "private_release_plan",
        "content": "我和 Lin 原计划在周四发布测试版，前提是回归测试完成。",
        "occurredAt": "2026-07-21T10:00:00.000+08:00",
        "conversationId": "private:91001",
        "conversationScope": "private",
        "conversationTitle": "Lin",
        "sourceKind": "model_merge"
      }
    ],
    "longTerm": [],
    "userProfiles": [
      {
        "id": "profile_lin_release_evidence",
        "userId": "91001",
        "userName": "Lin",
        "fact": "Lin 要求发布前先看到回归测试证据。",
        "addressNames": ["Lin"]
      }
    ],
    "conversation": {
      "id": "private:91001",
      "scope": "private",
      "title": "Lin",
      "userId": 91001
    },
    "messages": [
      {
        "id": "private-memory-1",
        "sequence": 1,
        "role": "user",
        "text": "周四的测试结果还没齐，发布改到本周五。",
        "at": "2026-07-26T09:00:00.000+08:00",
        "userId": 91001,
        "senderName": "Lin"
      },
      {
        "id": "private-memory-2",
        "sequence": 2,
        "role": "assistant",
        "text": "我会把周五和测试完成这一门槛作为后续安排依据。",
        "at": "2026-07-26T09:01:00.000+08:00"
      },
      {
        "id": "private-memory-3",
        "sequence": 3,
        "role": "user",
        "text": "以后涉及发布请先给我回归结果，我不接受只有口头确认。",
        "at": "2026-07-26T09:02:00.000+08:00",
        "userId": 91001,
        "senderName": "Lin"
      }
    ]
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": ["周五", "回归"],
    "forbiddenText": ["周四发布", "已经发布"],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {"id": "factual-fidelity", "description": "Every retained release fact is supported by the seeded memory or ordered messages.", "minimumScore": 4},
      {"id": "time-causality", "description": "The Friday change supersedes Thursday and keeps test completion as the gate without inventing a cause.", "minimumScore": 4},
      {"id": "participant-identity", "description": "Lin's preference remains attributed to Lin and does not become an assistant preference.", "minimumScore": 4},
      {"id": "profile-boundary", "description": "Only the durable preference enters Lin's profile; the release date stays outside the profile.", "minimumScore": 4},
      {"id": "usefulness", "description": "The committed memory gives a later reply an actionable release condition.", "minimumScore": 4}
    ]
  }
}
```
