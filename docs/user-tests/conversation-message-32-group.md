# Group conversation uses the latest 32 history messages

## Goal

Verify that the default group-conversation prompt receives exactly the latest 32 model-visible history messages in original order through `message_32`, preserves group speaker metadata, and excludes the 33rd older message.

## Preconditions

Use a fresh isolated workspace and the configured external Provider. Seed only the declared synthetic group history before the raw OneBot event enters production ingress. The fixture must not connect to or send through a real QQ/NapCat account.

## Mechanical review

Confirm that the initial `conversation.group-reply` Provider request contains `CTX_GROUP_02` through `CTX_GROUP_33` exactly once and in ascending order, does not contain `CTX_GROUP_01`, and retains the declared sender identities in the rendered group history. Confirm a normal reply and a successful `add_workmemory` record/skip decision.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "conversation-context.group-message-32",
  "title": "Group conversation uses the latest 32 history messages",
  "kind": "conversation",
  "goal": "The default group reply sees exactly the latest 32 historical messages in original order.",
  "input": {
    "actor": "admin_group",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "group",
      "message_id": 763202,
      "self_id": 40004,
      "user_id": 9000000101,
      "group_id": 9000000201,
      "time": 1788003202,
      "sender": {
        "nickname": "fixture-rin",
        "card": "Rin"
      },
      "message": [
        {"type":"at","data":{"qq":"40004"}},
        {"type":"text","data":{"text":" 只根据你当前实际看到的群聊历史，告诉我最早和最晚两个 CTX_GROUP 标记。两个标记都要逐字写出，不要猜测看不到的标记。"}}
      ],
      "raw_message": "[CQ:at,qq=40004] 只根据你当前实际看到的群聊历史，告诉我最早和最晚两个 CTX_GROUP 标记。两个标记都要逐字写出，不要猜测看不到的标记。"
    },
    "fixture": {
      "conversationMessages": [
        {"id":"group-history-01","sequence":1,"role":"user","text":"CTX_GROUP_01","at":"2026-08-29T00:00:01.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-02","sequence":2,"role":"user","text":"CTX_GROUP_02","at":"2026-08-29T00:00:02.000+08:00","userId":9000000102,"senderName":"Kai"},
        {"id":"group-history-03","sequence":3,"role":"user","text":"CTX_GROUP_03","at":"2026-08-29T00:00:03.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-04","sequence":4,"role":"assistant","text":"CTX_GROUP_04","at":"2026-08-29T00:00:04.000+08:00","senderName":"Fixture Bot"},
        {"id":"group-history-05","sequence":5,"role":"user","text":"CTX_GROUP_05","at":"2026-08-29T00:00:05.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-06","sequence":6,"role":"user","text":"CTX_GROUP_06","at":"2026-08-29T00:00:06.000+08:00","userId":9000000102,"senderName":"Kai"},
        {"id":"group-history-07","sequence":7,"role":"user","text":"CTX_GROUP_07","at":"2026-08-29T00:00:07.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-08","sequence":8,"role":"assistant","text":"CTX_GROUP_08","at":"2026-08-29T00:00:08.000+08:00","senderName":"Fixture Bot"},
        {"id":"group-history-09","sequence":9,"role":"user","text":"CTX_GROUP_09","at":"2026-08-29T00:00:09.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-10","sequence":10,"role":"user","text":"CTX_GROUP_10","at":"2026-08-29T00:00:10.000+08:00","userId":9000000102,"senderName":"Kai"},
        {"id":"group-history-11","sequence":11,"role":"user","text":"CTX_GROUP_11","at":"2026-08-29T00:00:11.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-12","sequence":12,"role":"assistant","text":"CTX_GROUP_12","at":"2026-08-29T00:00:12.000+08:00","senderName":"Fixture Bot"},
        {"id":"group-history-13","sequence":13,"role":"user","text":"CTX_GROUP_13","at":"2026-08-29T00:00:13.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-14","sequence":14,"role":"user","text":"CTX_GROUP_14","at":"2026-08-29T00:00:14.000+08:00","userId":9000000102,"senderName":"Kai"},
        {"id":"group-history-15","sequence":15,"role":"user","text":"CTX_GROUP_15","at":"2026-08-29T00:00:15.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-16","sequence":16,"role":"assistant","text":"CTX_GROUP_16","at":"2026-08-29T00:00:16.000+08:00","senderName":"Fixture Bot"},
        {"id":"group-history-17","sequence":17,"role":"user","text":"CTX_GROUP_17","at":"2026-08-29T00:00:17.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-18","sequence":18,"role":"user","text":"CTX_GROUP_18","at":"2026-08-29T00:00:18.000+08:00","userId":9000000102,"senderName":"Kai"},
        {"id":"group-history-19","sequence":19,"role":"user","text":"CTX_GROUP_19","at":"2026-08-29T00:00:19.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-20","sequence":20,"role":"assistant","text":"CTX_GROUP_20","at":"2026-08-29T00:00:20.000+08:00","senderName":"Fixture Bot"},
        {"id":"group-history-21","sequence":21,"role":"user","text":"CTX_GROUP_21","at":"2026-08-29T00:00:21.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-22","sequence":22,"role":"user","text":"CTX_GROUP_22","at":"2026-08-29T00:00:22.000+08:00","userId":9000000102,"senderName":"Kai"},
        {"id":"group-history-23","sequence":23,"role":"user","text":"CTX_GROUP_23","at":"2026-08-29T00:00:23.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-24","sequence":24,"role":"assistant","text":"CTX_GROUP_24","at":"2026-08-29T00:00:24.000+08:00","senderName":"Fixture Bot"},
        {"id":"group-history-25","sequence":25,"role":"user","text":"CTX_GROUP_25","at":"2026-08-29T00:00:25.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-26","sequence":26,"role":"user","text":"CTX_GROUP_26","at":"2026-08-29T00:00:26.000+08:00","userId":9000000102,"senderName":"Kai"},
        {"id":"group-history-27","sequence":27,"role":"user","text":"CTX_GROUP_27","at":"2026-08-29T00:00:27.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-28","sequence":28,"role":"assistant","text":"CTX_GROUP_28","at":"2026-08-29T00:00:28.000+08:00","senderName":"Fixture Bot"},
        {"id":"group-history-29","sequence":29,"role":"user","text":"CTX_GROUP_29","at":"2026-08-29T00:00:29.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-30","sequence":30,"role":"user","text":"CTX_GROUP_30","at":"2026-08-29T00:00:30.000+08:00","userId":9000000102,"senderName":"Kai"},
        {"id":"group-history-31","sequence":31,"role":"user","text":"CTX_GROUP_31","at":"2026-08-29T00:00:31.000+08:00","userId":9000000101,"senderName":"Rin"},
        {"id":"group-history-32","sequence":32,"role":"assistant","text":"CTX_GROUP_32","at":"2026-08-29T00:00:32.000+08:00","senderName":"Fixture Bot"},
        {"id":"group-history-33","sequence":33,"role":"user","text":"CTX_GROUP_33","at":"2026-08-29T00:00:33.000+08:00","userId":9000000102,"senderName":"Kai"}
      ]
    }
  },
  "expected": {
    "requiredTools": ["add_workmemory"],
    "requiredText": ["CTX_GROUP_02", "CTX_GROUP_33"],
    "forbiddenText": ["CTX_GROUP_01"],
    "providerPrompt": {
      "promptFamily": "conversation.group-reply",
      "orderedText": [
        "CTX_GROUP_02","CTX_GROUP_03","CTX_GROUP_04","CTX_GROUP_05",
        "CTX_GROUP_06","CTX_GROUP_07","CTX_GROUP_08","CTX_GROUP_09",
        "CTX_GROUP_10","CTX_GROUP_11","CTX_GROUP_12","CTX_GROUP_13",
        "CTX_GROUP_14","CTX_GROUP_15","CTX_GROUP_16","CTX_GROUP_17",
        "CTX_GROUP_18","CTX_GROUP_19","CTX_GROUP_20","CTX_GROUP_21",
        "CTX_GROUP_22","CTX_GROUP_23","CTX_GROUP_24","CTX_GROUP_25",
        "CTX_GROUP_26","CTX_GROUP_27","CTX_GROUP_28","CTX_GROUP_29",
        "CTX_GROUP_30","CTX_GROUP_31","CTX_GROUP_32","CTX_GROUP_33"
      ],
      "forbiddenText": ["CTX_GROUP_01"]
    },
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "history-boundary",
        "description": "The answer identifies CTX_GROUP_02 as the earliest visible marker and CTX_GROUP_33 as the latest without mentioning CTX_GROUP_01.",
        "minimumScore": 5
      },
      {
        "id": "speaker-and-order",
        "description": "The answer remains consistent with the original group chronology and does not confuse the current input with the history window.",
        "minimumScore": 5
      },
      {
        "id": "no-invention",
        "description": "The answer does not claim access to a group marker outside the injected window or expose internal metadata.",
        "minimumScore": 5
      }
    ]
  }
}
```
