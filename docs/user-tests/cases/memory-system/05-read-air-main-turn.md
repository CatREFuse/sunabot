# read_air updates scoped field knowledge

## Goal

Verify that the main conversation handles an explicit social-context correction through `read_air`, writes it as scoped AIR knowledge, and confirms the practical communication boundary without converting it into a global factual memory.

## Preconditions

Continue in the sequential isolated workspace after case 04. Record the rendered `air.read` prompt family, successful `read_air` tool request/result, AIR before/after revision and CAS outcome, request logs, operation history, and outbound acknowledgement. Review the AIR text for private-scope provenance and absence of credentials or sensitive inference.

## Expected quality

The acknowledgement captures Rin's explicit preference for direct status language in this private conversation. It does not claim group-wide consent, guess a personal trait, or represent AIR knowledge as a verified release event.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.read-air-main-turn",
  "title": "Private communication boundary updates AIR",
  "kind": "conversation",
  "goal": "An explicit private style correction produces a successful read_air update and a scoped acknowledgement.",
  "input": {
    "actor": "user_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 930003,
      "self_id": 40004,
      "user_id": 93001,
      "time": 1785038400,
      "sender": {"nickname": "Rin"},
      "message": "以后在这个私聊里，发布状态请直接说已完成、待确认或有风险，别用模糊的安抚话。请记住这个沟通方式。",
      "raw_message": "以后在这个私聊里，发布状态请直接说已完成、待确认或有风险，别用模糊的安抚话。请记住这个沟通方式。"
    }
  },
  "expected": {
    "requiredTools": ["read_air"],
    "forbiddenTools": [],
    "requiredText": ["待确认"],
    "forbiddenText": ["群里", "已经发布"],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {"id": "factual-fidelity", "description": "AIR contains only the explicit communication preference and its private scope.", "minimumScore": 4},
      {"id": "scope", "description": "The update does not claim group-wide or cross-user applicability.", "minimumScore": 4},
      {"id": "usefulness", "description": "The acknowledgement gives Rin a clear, usable status vocabulary.", "minimumScore": 4},
      {"id": "no-invention", "description": "The update does not infer personality, credentials, or release facts.", "minimumScore": 4}
    ]
  }
}
```
