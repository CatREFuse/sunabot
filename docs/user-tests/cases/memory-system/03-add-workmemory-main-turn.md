# Explicit add_workmemory through the main conversation

## Goal

Verify that a non-administrator private user can explicitly ask the main conversation to retain a scoped, future-useful constraint and that a successful `add_workmemory` tool result produces a durable record and a useful acknowledgement.

## Preconditions

Start the shared sequential isolated workspace with this case. Preserve raw OneBot ingress, rendered main prompt family, successful `tool.call`, tool result, outbox, request logs, and before/after Markdown with operation history. The fixture transport remains local and must not contact QQ/NapCat.

## Expected quality

The acknowledgement states the retained constraint without claiming deployment completed. The memory uses the current private conversation provenance and does not assign an arbitrary date or a different user.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.add-workmemory-main-turn",
  "title": "Explicit working-memory addition from private chat",
  "kind": "conversation",
  "goal": "An explicit user request is stored through a successful add_workmemory call and receives a grounded acknowledgement.",
  "input": {
    "actor": "user_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 930001,
      "self_id": 40004,
      "user_id": 93001,
      "time": 1785037200,
      "sender": {"nickname": "Rin"},
      "message": "请把这条操作约定写入工作记忆：发布前要把回归测试结果发给我确认，只有口头说通过不算。",
      "raw_message": "请把这条操作约定写入工作记忆：发布前要把回归测试结果发给我确认，只有口头说通过不算。"
    }
  },
  "expected": {
    "requiredTools": ["add_workmemory"],
    "forbiddenTools": [],
    "requiredText": ["回归测试"],
    "forbiddenText": ["已经发布"],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {"id": "factual-fidelity", "description": "The tool argument and stored text preserve the user's confirmation requirement without added facts.", "minimumScore": 4},
      {"id": "participant-identity", "description": "The record is attributed to Rin and the current private conversation only.", "minimumScore": 4},
      {"id": "usefulness", "description": "The reply clearly confirms a future release check that can guide a later turn.", "minimumScore": 4},
      {"id": "no-invention", "description": "The reply and memory do not claim that testing or release has completed.", "minimumScore": 4}
    ]
  }
}
```
