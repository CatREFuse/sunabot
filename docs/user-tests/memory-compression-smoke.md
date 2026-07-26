# Memory-compression harness smoke

## Goal

Verify that ordered mock messages enter the production memory-compression branch and produce a successful working-memory commit in the isolated Agent workspace.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "harness.memory-compression-smoke",
  "title": "Memory compression smoke",
  "kind": "memory_compression",
  "goal": "The memory branch retains the explicit release decision and does not invent unrelated facts.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-26T06:05:00.000+08:00",
    "workingMemory": [],
    "longTerm": [],
    "userProfiles": [],
    "conversation": {
      "id": "private:99112233",
      "scope": "private",
      "title": "Fixture user",
      "userId": 99112233
    },
    "messages": [
      {
        "id": "fixture-memory-1",
        "sequence": 1,
        "role": "user",
        "text": "我们决定周五发布 0.1.4，发布前必须完成回归测试。",
        "at": "2026-07-26T06:00:00.000+08:00",
        "userId": 99112233,
        "senderName": "Fixture user"
      },
      {
        "id": "fixture-memory-2",
        "sequence": 2,
        "role": "assistant",
        "text": "收到，我会把周五发布与回归测试门禁作为后续工作依据。",
        "at": "2026-07-26T06:01:00.000+08:00"
      }
    ]
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": [
      "0.1.4",
      "回归测试"
    ],
    "forbiddenText": [],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {
        "id": "factuality",
        "description": "The committed memory contains only facts supported by the supplied messages.",
        "minimumScore": 4
      },
      {
        "id": "usefulness",
        "description": "The release date and regression-test requirement remain useful for later replies.",
        "minimumScore": 4
      }
    ]
  }
}
```
