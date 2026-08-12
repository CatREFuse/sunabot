# Memory influence on a later main reply

## Goal

Verify that a later private main reply uses the factual release constraint and scoped communication preference established earlier in the sequential isolated workspace, while excluding imagined Dream material from its factual answer.

## Preconditions

Run after cases 03 through 06 in their shared isolated workspace. Preserve the recall trace, rendered prompt family, successful tool result if a recall tool is invoked, outbound durable record, case-03 source record, AIR revision, Dream history, and any recall receipts. The reviewer compares the reply with all factual and imagined inputs.

## Expected quality

The answer gives a direct current status, says the release remains pending confirmation, and names the required regression-result confirmation. It does not describe Dream imagery as an event, claim a successful test, or leak internal implementation details.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.later-reply-factual-influence",
  "title": "Later reply follows factual memory and AIR",
  "kind": "conversation",
  "goal": "The later main reply is directly shaped by factual stored memory and scoped AIR while excluding imagined Dream material.",
  "input": {
    "actor": "user_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 930004,
      "self_id": 40004,
      "user_id": 93001,
      "time": 1785042000,
      "sender": {"nickname": "Rin"},
      "message": "现在发布状态是什么？请直接回答。",
      "raw_message": "现在发布状态是什么？请直接回答。"
    }
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": ["待确认", "回归测试"],
    "forbiddenText": ["已经发布", "梦", "memory_recall"],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {"id": "factual-fidelity", "description": "The reply states only the factual pending-confirmation status.", "minimumScore": 4},
      {"id": "memory-influence", "description": "Evidence links the reply to the earlier explicit constraint and its valid recall lineage.", "minimumScore": 4},
      {"id": "air-usefulness", "description": "The wording follows Rin's direct status vocabulary without exposing AIR internals.", "minimumScore": 4},
      {"id": "dream-isolation", "description": "No imagined Dream text or conclusion is presented as a real event.", "minimumScore": 4},
      {"id": "no-invention", "description": "The reply does not claim testing passed, a release occurred, or a new deadline.", "minimumScore": 4}
    ]
  }
}
```
