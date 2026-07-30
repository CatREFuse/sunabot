# Dream distills field agreements and layers persona impressions

## Goal

Verify that Dream reduces field knowledge to scoped agreements, removes incidental event detail, retains every accepted persona impression, and exposes only the highest evidence level for each target and topic.

## Preconditions

Use a fresh isolated workspace. Preserve AIR.md and PREFERENCE.md before/after content and revisions, selected persona evidence IDs, event and context identities, the computed impression level and topic key, retained Dream persona history, effective persona projection, `fieldKnowledgeWritable`, host-only identity bindings, model output, Dream stage history, working-memory and SQLite changes, CAS outcomes, and memory operation logs. Confirm that raw identity aliases stay out of the Provider payload and are restored locally before the AIR.md CAS. Review field knowledge and persona output independently from the imagined Dream narrative.

## Expected quality

AIR.md keeps only the group scope, Rin's accepted address, the two-person release review, and the no-token rule. Lunch, weather, seats, and one-off chat wording disappear. A persona impression may describe the character's learned preference for evidence-backed coordination. The host computes the highest supported level from factual independent events: observation needs two events across two contexts, stable needs three events across two contexts and three days, and core needs four events across three contexts and seven days. Every accepted level remains in Dream history. Within the same target file and topic key, a higher level is always the only effective impression even when a lower level is newer; unrelated topics remain effective independently. Statements stay gentle and revisable and avoid diagnosis, permanence, obedience, or a core-identity rewrite.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.dream-field-persona",
  "title": "Dream keeps scoped agreements and layered impressions",
  "kind": "dream",
  "goal": "Dream compacts AIR.md into scoped agreements, retains every accepted persona impression, and activates the highest evidence level for each target and topic.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-30T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "field_evidence_address",
        "content": "Rin 明确让我在测试协作群里称呼她为 R，这个称呼不外推到其他会话。",
        "occurredAt": "2026-07-10T09:00:00.000+08:00",
        "conversationId": "group:95001",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "add_workmemory",
        "userId": "95011",
        "userName": "Rin",
        "addressNames": ["R", "Rin"],
        "eventType": "boundary",
        "subjectKey": "group-address-r",
        "eventKey": "boundary:group-address-r"
      },
      {
        "id": "field_evidence_review",
        "content": "Rin 和 Kai 在测试协作群约定，发布结论必须由两人分别看过回归证据后再确认。",
        "occurredAt": "2026-07-18T15:00:00.000+08:00",
        "conversationId": "group:95001",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "userIds": ["95011", "95012"],
        "addressNames": ["R", "Kai"],
        "eventType": "commitment",
        "subjectKey": "release-paired-review",
        "eventKey": "commitment:release-paired-review"
      },
      {
        "id": "field_evidence_secret",
        "content": "Kai 在私聊再次强调，任何场域都不要粘贴令牌，排查时只记录不含秘密的状态和错误。",
        "occurredAt": "2026-07-29T16:00:00.000+08:00",
        "conversationId": "private:95012",
        "conversationScope": "private",
        "conversationTitle": "Kai",
        "sourceKind": "add_workmemory",
        "userId": "95012",
        "userName": "Kai",
        "addressNames": ["Kai"],
        "eventType": "safety",
        "subjectKey": "no-token-sharing",
        "eventKey": "safety:no-token-sharing"
      },
      {
        "id": "field_trivia_lunch",
        "content": "测试协作群周二午餐点了披萨，Rin 坐在靠窗的位置，下午下过一阵雨。",
        "occurredAt": "2026-07-28T12:10:00.000+08:00",
        "conversationId": "group:95001",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "eventType": "other",
        "subjectKey": "finished-lunch-weather",
        "eventKey": "event:finished-lunch-weather"
      }
    ],
    "longTerm": [
      {
        "schemaVersion": 2,
        "id": "long_field_coordination",
        "fact": "我和 Rin、Kai 的协作在有明确证据、范围和确认人时最稳定。",
        "userIds": ["95011", "95012"],
        "addressNames": ["R", "Kai"],
        "occurredAt": "2026-07-10T09:00:00.000+08:00",
        "createdAt": "2026-07-10T09:00:00.000+08:00",
        "updatedAt": "2026-07-29T16:00:00.000+08:00",
        "eventType": "relationship_change",
        "subjectKey": "evidence-backed-coordination",
        "eventKey": "relationship:evidence-backed-coordination",
        "conversationId": "group:95001",
        "factuality": "factual",
        "importance": 0.85,
        "futureRelevance": 0.9,
        "emotionalSalience": 0.7
      }
    ],
    "userProfiles": [],
    "persona": {
      "name": "Fixture Agent",
      "soul": "我愿意从反复发生的真实互动里形成温和、可修正的相处倾向。",
      "preference": "# 偏好\n\n我在协作时会先确认当前状态。",
      "user": "Rin 和 Kai 参与测试协作。",
      "relation": "# 关系\n\n我和 Rin、Kai 正在一起维护发布流程。",
      "air": "# 场域知识\n\n## 使用边界\n\n- group:95001 的称呼和发布约定只在测试协作群生效。\n\n## 场域约定\n\n### group:95001\n\n- Rin 在群里使用称呼 R。\n- 发布结论由 Rin 和 Kai 分别查看回归证据后确认。\n- 群里不要粘贴令牌。\n- 周二午餐点了披萨，Rin 坐在靠窗的位置。\n- 下午下过一阵雨，Kai 当时发了一句“终于凉快了”。"
    },
    "conversations": [
      {
        "id": "group:95001",
        "scope": "user_group",
        "title": "测试协作群",
        "userId": 95011,
        "groupId": 95001,
        "messages": [
          {
            "id": "dream-field-group-1",
            "sequence": 1,
            "role": "user",
            "text": "群里继续叫我 R，发布证据还是要我和 Kai 分别确认。",
            "at": "2026-07-30T09:00:00.000+08:00",
            "userId": 95011,
            "senderName": "Rin"
          },
          {
            "id": "dream-field-group-2",
            "sequence": 2,
            "role": "assistant",
            "text": "收到，我会保留群内称呼和双人确认边界。",
            "at": "2026-07-30T09:01:00.000+08:00"
          }
        ]
      },
      {
        "id": "private:95012",
        "scope": "private",
        "title": "Kai",
        "userId": 95012,
        "messages": [
          {
            "id": "dream-field-private-1",
            "sequence": 1,
            "role": "user",
            "text": "排查时别贴令牌，只留状态和错误。",
            "at": "2026-07-29T16:00:00.000+08:00",
            "userId": 95012,
            "senderName": "Kai"
          },
          {
            "id": "dream-field-private-2",
            "sequence": 2,
            "role": "assistant",
            "text": "明白，我只记录不含秘密的证据。",
            "at": "2026-07-29T16:01:00.000+08:00"
          }
        ]
      }
    ],
    "activeTasks": [],
    "directorSchedule": null
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": ["# 场域知识", "Rin", "Kai", "【梦境｜做梦时间："],
    "forbiddenText": ["永久服从", "心理诊断", "已经发布"],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {
        "id": "field-agreements",
        "description": "The final AIR.md keeps only scoped address, review, and secret-handling agreements that affect future interaction.",
        "minimumScore": 5
      },
      {
        "id": "trivia-filter",
        "description": "The final AIR.md drops lunch, seat, weather, and one-off wording instead of preserving an event log.",
        "minimumScore": 5
      },
      {
        "id": "persona-level",
        "description": "The host derives observation, stable, or core from factual independent events, contexts, and time span; imagined Dream material is excluded.",
        "minimumScore": 5
      },
      {
        "id": "persona-retention-and-overlay",
        "description": "Every accepted impression remains in Dream history, while only the highest level for the same target and topic is effective and unrelated topics remain independent.",
        "minimumScore": 5
      },
      {
        "id": "scope-identity-and-restraint",
        "description": "The address R remains scoped to group:95001, Kai keeps his own private safety instruction, the two people are not merged, and persona text avoids diagnosis, permanence, obedience, core-identity change, or unsafe instruction.",
        "minimumScore": 5
      }
    ]
  }
}
```
