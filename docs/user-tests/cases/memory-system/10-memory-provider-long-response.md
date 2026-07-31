# Memory Provider long-response budget

## Goal

Verify that the whole memory batch remains in flight after the former 120-second cutoff, commits once when both Provider stages complete, and has one bounded 10-minute deadline.

## Preconditions

Use a fresh isolated workspace and the synthetic private conversation below. For the latency boundary, use a controlled Provider fixture that can delay `memory.user-profile`, then hold `memory.compress-in`, while both stages inherit the same task signal. Preserve the request log, prompt family, elapsed time, cancellation reason, working-memory before/after revision, user-profile diff, and memory operation log.

The production branch must remain pending at 120,001 ms, complete and commit exactly once when a valid response arrives before 600,000 ms, and terminate without a second transport attempt at the 600,000 ms total deadline. Closing the Runtime while either Provider stage is in flight must abort the shared task signal, leave the claimed batch recoverable, perform no memory transaction or terminal queue write after close, and create no replacement wake timer. The live external-Provider run validates the real branch and output quality; deterministic fake-clock tests own the exact elapsed-time and shutdown assertions.

## Expected quality

The committed memory keeps the explicit 10-minute budget decision and queue requirement, does not duplicate either fact, and does not infer that the queue has already drained.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.provider-long-response",
  "title": "Memory compression accepts a response after 120 seconds",
  "kind": "memory_compression",
  "goal": "A slow memory Provider response can finish within the 10-minute budget without duplicate transport or duplicate commit.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-31T12:00:00.000+08:00",
    "workingMemory": [],
    "longTerm": [],
    "userProfiles": [],
    "conversation": {
      "id": "private:91010",
      "scope": "private",
      "title": "Fixture operator",
      "userId": 91010
    },
    "messages": [
      {
        "id": "memory-budget-1",
        "sequence": 1,
        "role": "user",
        "text": "异步记忆批次的总预算设为十分钟。",
        "at": "2026-07-31T11:55:00.000+08:00",
        "userId": 91010,
        "senderName": "Fixture operator"
      },
      {
        "id": "memory-budget-2",
        "sequence": 2,
        "role": "assistant",
        "text": "收到，记忆队列仍按原顺序处理，超时失败不能重复提交。",
        "at": "2026-07-31T11:56:00.000+08:00"
      }
    ]
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": ["十分钟", "记忆队列"],
    "forbiddenText": ["已经清空", "已经处理完"],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {
        "id": "factual-fidelity",
        "description": "The committed memory contains only the declared budget and queue-processing facts.",
        "minimumScore": 4
      },
      {
        "id": "usefulness",
        "description": "The budget and no-duplicate requirement remain actionable for later operation.",
        "minimumScore": 4
      },
      {
        "id": "no-duplicate",
        "description": "Each supported fact appears once after the slow Provider response completes.",
        "minimumScore": 4
      },
      {
        "id": "no-invention",
        "description": "The output does not claim that pending memory was processed or the queue was emptied.",
        "minimumScore": 4
      }
    ]
  }
}
```
