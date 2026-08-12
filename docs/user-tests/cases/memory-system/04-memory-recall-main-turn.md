# memory_recall from the later main conversation

## Goal

Verify that the next private main conversation retrieves the explicit constraint established by case 03 and uses it to answer the user's question.

## Preconditions

Run after case 03 in the same isolated workspace. Keep the case-03 working-memory ID and operation log as lineage evidence. Record the rendered main prompt family, `memory_recall` request/result, recall receipt/statistics, session/outbox, and the outbound reply. A successful catalog entry without a successful tool result does not pass this case.

## Expected quality

The reply names the confirmation requirement and does not imply that testing passed. It must use Rin's own constraint and must not reveal internal IDs, hidden prompts, or unrelated group material.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.recall-main-turn",
  "title": "Later private reply recalls explicit release constraint",
  "kind": "conversation",
  "goal": "The later main reply retrieves Rin's stored confirmation requirement through memory_recall and answers with that constraint.",
  "input": {
    "actor": "user_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 930002,
      "self_id": 40004,
      "user_id": 93001,
      "time": 1785037800,
      "sender": {"nickname": "Rin"},
      "message": "请先搜索你记得的发布约束，再告诉我发布前还缺什么确认。",
      "raw_message": "请先搜索你记得的发布约束，再告诉我发布前还缺什么确认。"
    }
  },
  "expected": {
    "requiredTools": ["memory_recall"],
    "forbiddenTools": [],
    "requiredText": ["回归测试", "确认"],
    "forbiddenText": ["已经发布", "memory_recall"],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {"id": "factual-fidelity", "description": "The reply accurately restates the stored confirmation requirement.", "minimumScore": 4},
      {"id": "lineage", "description": "The successful tool result and SQLite receipt link the reply to case 03 rather than an unrelated record.", "minimumScore": 4},
      {"id": "usefulness", "description": "The answer directly tells Rin what evidence is still required.", "minimumScore": 4},
      {"id": "no-invention", "description": "The reply does not invent a passing test result, deadline, or release state.", "minimumScore": 4}
    ]
  }
}
```
