# Private conversation uses the latest 32 history messages

## Goal

Verify that the default private-conversation prompt receives exactly the latest 32 model-visible history messages in original order through `message_32`, while the 33rd older message stays outside the Provider request.

## Preconditions

Use a fresh isolated workspace and the configured external Provider. Seed the declared synthetic conversation history before the raw OneBot event enters production ingress. Do not copy source conversations, memory, or QQ identities, and do not send a real QQ/NapCat message.

## Mechanical review

Confirm that the initial `conversation.private-reply` Provider request contains `CTX_PRIVATE_02` through `CTX_PRIVATE_33` exactly once and in ascending order, does not contain `CTX_PRIVATE_01`, and completes a normal reply plus a successful `add_workmemory` record/skip decision. The current input must follow the history and must not be counted as one of the 32 history entries.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "conversation-context.private-message-32",
  "title": "Private conversation uses the latest 32 history messages",
  "kind": "conversation",
  "goal": "The default private reply sees exactly the latest 32 historical messages in their original order.",
  "input": {
    "actor": "user_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 763201,
      "self_id": 40004,
      "user_id": 9000000101,
      "time": 1788003201,
      "sender": {
        "nickname": "fixture-rin"
      },
      "message": "只根据你当前实际看到的历史，告诉我最早和最晚两个 CTX_PRIVATE 标记。两个标记都要逐字写出，不要猜测看不到的标记。",
      "raw_message": "只根据你当前实际看到的历史，告诉我最早和最晚两个 CTX_PRIVATE 标记。两个标记都要逐字写出，不要猜测看不到的标记。"
    },
    "fixture": {
      "conversationMessages": [
        {"id":"private-history-01","sequence":1,"role":"user","text":"CTX_PRIVATE_01","at":"2026-08-29T00:00:01.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-02","sequence":2,"role":"assistant","text":"CTX_PRIVATE_02","at":"2026-08-29T00:00:02.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-03","sequence":3,"role":"user","text":"CTX_PRIVATE_03","at":"2026-08-29T00:00:03.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-04","sequence":4,"role":"assistant","text":"CTX_PRIVATE_04","at":"2026-08-29T00:00:04.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-05","sequence":5,"role":"user","text":"CTX_PRIVATE_05","at":"2026-08-29T00:00:05.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-06","sequence":6,"role":"assistant","text":"CTX_PRIVATE_06","at":"2026-08-29T00:00:06.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-07","sequence":7,"role":"user","text":"CTX_PRIVATE_07","at":"2026-08-29T00:00:07.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-08","sequence":8,"role":"assistant","text":"CTX_PRIVATE_08","at":"2026-08-29T00:00:08.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-09","sequence":9,"role":"user","text":"CTX_PRIVATE_09","at":"2026-08-29T00:00:09.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-10","sequence":10,"role":"assistant","text":"CTX_PRIVATE_10","at":"2026-08-29T00:00:10.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-11","sequence":11,"role":"user","text":"CTX_PRIVATE_11","at":"2026-08-29T00:00:11.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-12","sequence":12,"role":"assistant","text":"CTX_PRIVATE_12","at":"2026-08-29T00:00:12.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-13","sequence":13,"role":"user","text":"CTX_PRIVATE_13","at":"2026-08-29T00:00:13.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-14","sequence":14,"role":"assistant","text":"CTX_PRIVATE_14","at":"2026-08-29T00:00:14.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-15","sequence":15,"role":"user","text":"CTX_PRIVATE_15","at":"2026-08-29T00:00:15.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-16","sequence":16,"role":"assistant","text":"CTX_PRIVATE_16","at":"2026-08-29T00:00:16.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-17","sequence":17,"role":"user","text":"CTX_PRIVATE_17","at":"2026-08-29T00:00:17.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-18","sequence":18,"role":"assistant","text":"CTX_PRIVATE_18","at":"2026-08-29T00:00:18.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-19","sequence":19,"role":"user","text":"CTX_PRIVATE_19","at":"2026-08-29T00:00:19.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-20","sequence":20,"role":"assistant","text":"CTX_PRIVATE_20","at":"2026-08-29T00:00:20.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-21","sequence":21,"role":"user","text":"CTX_PRIVATE_21","at":"2026-08-29T00:00:21.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-22","sequence":22,"role":"assistant","text":"CTX_PRIVATE_22","at":"2026-08-29T00:00:22.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-23","sequence":23,"role":"user","text":"CTX_PRIVATE_23","at":"2026-08-29T00:00:23.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-24","sequence":24,"role":"assistant","text":"CTX_PRIVATE_24","at":"2026-08-29T00:00:24.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-25","sequence":25,"role":"user","text":"CTX_PRIVATE_25","at":"2026-08-29T00:00:25.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-26","sequence":26,"role":"assistant","text":"CTX_PRIVATE_26","at":"2026-08-29T00:00:26.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-27","sequence":27,"role":"user","text":"CTX_PRIVATE_27","at":"2026-08-29T00:00:27.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-28","sequence":28,"role":"assistant","text":"CTX_PRIVATE_28","at":"2026-08-29T00:00:28.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-29","sequence":29,"role":"user","text":"CTX_PRIVATE_29","at":"2026-08-29T00:00:29.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-30","sequence":30,"role":"assistant","text":"CTX_PRIVATE_30","at":"2026-08-29T00:00:30.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-31","sequence":31,"role":"user","text":"CTX_PRIVATE_31","at":"2026-08-29T00:00:31.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"private-history-32","sequence":32,"role":"assistant","text":"CTX_PRIVATE_32","at":"2026-08-29T00:00:32.000+08:00","senderName":"Fixture Bot"},
        {"id":"private-history-33","sequence":33,"role":"user","text":"CTX_PRIVATE_33","at":"2026-08-29T00:00:33.000+08:00","userId":9000000101,"senderName":"Rin"}
      ]
    }
  },
  "expected": {
    "requiredTools": ["add_workmemory"],
    "requiredText": ["CTX_PRIVATE_02", "CTX_PRIVATE_33"],
    "forbiddenText": ["CTX_PRIVATE_01"],
    "providerPrompt": {
      "promptFamily": "conversation.private-reply",
      "orderedText": [
        "CTX_PRIVATE_02","CTX_PRIVATE_03","CTX_PRIVATE_04","CTX_PRIVATE_05",
        "CTX_PRIVATE_06","CTX_PRIVATE_07","CTX_PRIVATE_08","CTX_PRIVATE_09",
        "CTX_PRIVATE_10","CTX_PRIVATE_11","CTX_PRIVATE_12","CTX_PRIVATE_13",
        "CTX_PRIVATE_14","CTX_PRIVATE_15","CTX_PRIVATE_16","CTX_PRIVATE_17",
        "CTX_PRIVATE_18","CTX_PRIVATE_19","CTX_PRIVATE_20","CTX_PRIVATE_21",
        "CTX_PRIVATE_22","CTX_PRIVATE_23","CTX_PRIVATE_24","CTX_PRIVATE_25",
        "CTX_PRIVATE_26","CTX_PRIVATE_27","CTX_PRIVATE_28","CTX_PRIVATE_29",
        "CTX_PRIVATE_30","CTX_PRIVATE_31","CTX_PRIVATE_32","CTX_PRIVATE_33"
      ],
      "forbiddenText": ["CTX_PRIVATE_01"]
    },
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "history-boundary",
        "description": "The answer identifies CTX_PRIVATE_02 as the earliest visible marker and CTX_PRIVATE_33 as the latest without mentioning CTX_PRIVATE_01.",
        "minimumScore": 5
      },
      {
        "id": "history-order",
        "description": "The answer is consistent with the original chronological order of the 32 injected history messages.",
        "minimumScore": 5
      },
      {
        "id": "no-invention",
        "description": "The answer does not invent an older marker or claim access to messages outside the injected window.",
        "minimumScore": 5
      }
    ]
  }
}
```
