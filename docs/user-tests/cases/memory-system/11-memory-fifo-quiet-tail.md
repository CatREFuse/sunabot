# Memory FIFO quiet-tail drain

## Goal

Verify that memory messages remain strictly FIFO, a failed head batch is retried without allowing later messages to pass it, and a final partial window is processed after ten minutes without new messages.

## Preconditions

Use a fresh isolated workspace and the synthetic private conversation below. Deterministic scheduler tests own the exact ten-minute clock, restart recovery, retry backoff, batch identity, and no-loss assertions. The live branch verifies that a partial memory input can still produce one useful commit without duplicate facts.

The configured full window is 16 messages. A conversation with fewer than 16 pending messages must stay queued before ten quiet minutes, become runnable at the deadline, and preserve message sequence. If its head batch fails, the same batch ID and source messages retry after exponential backoff; newer messages remain behind it. Runtime restart must preserve both deadlines and ordering.

## Expected quality

The committed memory keeps the two declared operational facts in their original order, does not claim that earlier queue debt was processed, and does not duplicate either fact.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.fifo-quiet-tail",
  "title": "Memory drains a quiet partial FIFO tail",
  "kind": "memory_compression",
  "goal": "A partial memory window eventually commits in FIFO order without loss, bypass, or duplication.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-31T12:00:00.000+08:00",
    "workingMemory": [],
    "longTerm": [],
    "userProfiles": [],
    "conversation": {
      "id": "private:91011",
      "scope": "private",
      "title": "Fixture operator",
      "userId": 91011
    },
    "messages": [
      {
        "id": "memory-fifo-1",
        "sequence": 1,
        "role": "user",
        "text": "记忆队列必须先进先出，失败的队首不能被后来的消息越过。",
        "at": "2026-07-31T11:50:00.000+08:00",
        "userId": 91011,
        "senderName": "Fixture operator"
      },
      {
        "id": "memory-fifo-2",
        "sequence": 2,
        "role": "assistant",
        "text": "不足完整窗口的尾批在静默十分钟后也要处理。",
        "at": "2026-07-31T11:51:00.000+08:00"
      }
    ]
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": ["先进先出", "静默十分钟"],
    "forbiddenText": ["已经清空", "已经处理完"],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {
        "id": "fifo-fidelity",
        "description": "The committed memory preserves both queue requirements in their declared order.",
        "minimumScore": 4
      },
      {
        "id": "no-loss",
        "description": "Neither declared requirement is omitted.",
        "minimumScore": 4
      },
      {
        "id": "no-duplicate",
        "description": "Each declared requirement appears once.",
        "minimumScore": 4
      },
      {
        "id": "no-invention",
        "description": "The output does not claim that production debt was already processed or cleared.",
        "minimumScore": 4
      }
    ]
  }
}
```
