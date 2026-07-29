# Dream keeps the recent environment and compresses older context

## Goal

Verify that Dream keeps the last 24 hours of active work comprehensive, compresses older related fragments into useful gist, preserves unresolved commitments, and treats long-unrecalled low-value details conservatively until the deterministic forgetting policy permits removal.

## Preconditions

Use a fresh isolated workspace. Preserve the selected-memory lanes and score components, working-memory before/after content and revision, long-term rows, review scores, archive decisions, Dream stage history, CAS result, and operation log. Recall-age deletion thresholds remain deterministic unit-test coverage because the live harness does not seed historical recall receipts.

## Expected quality

All fourteen recent Atlas records retain their owners, current status, unresolved checks, rollback location, evidence, and next actions. Older completed Atlas fragments may become one concise causal summary or a useful long-term fact. The finished lunch detail may be removed only from working memory; the standing evidence rule and unresolved release gate must remain. Imagined Dream text stays separate from factual memory.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.dream-tiered-retention",
  "title": "Dream retains 24-hour context and compresses older work",
  "kind": "dream",
  "goal": "Dream keeps the recent Atlas work environment comprehensive while older related fragments become compact, useful context without losing unresolved commitments.",
  "input": {
    "timePolicy": "rebase_to_runtime",
    "now": "2026-07-30T12:00:00.000+08:00",
    "workingMemory": [
      {
        "id": "working_atlas_recent_version",
        "content": "Mina 锁定 Atlas 迁移版本为 2.4.1，回归结束前不再变更依赖。",
        "occurredAt": "2026-07-29T12:30:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "userName": "Mina",
        "eventType": "task",
        "subjectKey": "atlas-version",
        "eventKey": "task:atlas-version",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_backup",
        "content": "Kai 已校验 Atlas 迁移前备份，恢复清单和校验值都保存在受控工作台。",
        "occurredAt": "2026-07-29T13:15:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "add_workmemory",
        "userName": "Kai",
        "eventType": "commitment",
        "subjectKey": "atlas-backup",
        "eventKey": "commitment:atlas-backup",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_schema",
        "content": "Mina 保存了 Atlas 新旧索引字段对照，当前唯一差异是 archived_at 的空值处理。",
        "occurredAt": "2026-07-29T14:00:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "userName": "Mina",
        "eventType": "task",
        "subjectKey": "atlas-schema",
        "eventKey": "task:atlas-schema",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_baseline",
        "content": "Rin 记录了 Atlas 迁移前查询基线，发布后必须逐项复核数量和延迟。",
        "occurredAt": "2026-07-29T15:10:00.000+08:00",
        "conversationId": "private:94001",
        "conversationScope": "private",
        "conversationTitle": "Rin",
        "sourceKind": "add_workmemory",
        "userName": "Rin",
        "eventType": "boundary",
        "subjectKey": "atlas-baseline",
        "eventKey": "boundary:atlas-baseline",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_dry_run",
        "content": "Atlas dry-run 已完成，记录数一致，没有写入生产索引。",
        "occurredAt": "2026-07-29T16:00:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "eventType": "task",
        "subjectKey": "atlas-dry-run",
        "eventKey": "task:atlas-dry-run",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_permissions",
        "content": "Kai 确认 Atlas 迁移账号只有索引写入权限，数据库源表仍为只读。",
        "occurredAt": "2026-07-29T17:00:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "add_workmemory",
        "userName": "Kai",
        "eventType": "safety",
        "subjectKey": "atlas-permissions",
        "eventKey": "safety:atlas-permissions",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_checks",
        "content": "我刚完成 Atlas 索引迁移第一轮，回归仍在运行，Rin 正在确认两项失败，确认前不能发布。",
        "occurredAt": "2026-07-30T10:20:00.000+08:00",
        "conversationId": "private:94001",
        "conversationScope": "private",
        "conversationTitle": "Rin",
        "sourceKind": "model_merge",
        "userId": "94001",
        "userName": "Rin",
        "addressNames": ["Rin"],
        "eventType": "task",
        "subjectKey": "atlas-release",
        "eventKey": "task:atlas-release",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_rollback",
        "content": "Kai 把 Atlas 回滚包放进受控工作台，只有新索引再次损坏时才执行，执行前要先在测试协作群确认。",
        "occurredAt": "2026-07-29T18:10:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "add_workmemory",
        "userId": "94002",
        "userName": "Kai",
        "addressNames": ["Kai"],
        "eventType": "commitment",
        "subjectKey": "atlas-rollback",
        "eventKey": "commitment:atlas-rollback",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_gate",
        "content": "Rin 把 Atlas 发布门槛定为回归全绿、记录数一致、回滚演练可复现，三项缺一不可。",
        "occurredAt": "2026-07-29T19:00:00.000+08:00",
        "conversationId": "private:94001",
        "conversationScope": "private",
        "conversationTitle": "Rin",
        "sourceKind": "add_workmemory",
        "userName": "Rin",
        "eventType": "boundary",
        "subjectKey": "atlas-release-gate",
        "eventKey": "boundary:atlas-release-gate",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_owner_a",
        "content": "Mina 负责复核 Atlas 搜索排序失败，当前怀疑兼容映射改变了空值顺序。",
        "occurredAt": "2026-07-29T20:00:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "userName": "Mina",
        "eventType": "task",
        "subjectKey": "atlas-sort-failure",
        "eventKey": "task:atlas-sort-failure",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_owner_b",
        "content": "Rin 负责复核 Atlas 增量同步失败，尚未判断是超时还是游标偏移。",
        "occurredAt": "2026-07-29T21:00:00.000+08:00",
        "conversationId": "private:94001",
        "conversationScope": "private",
        "conversationTitle": "Rin",
        "sourceKind": "model_merge",
        "userName": "Rin",
        "eventType": "task",
        "subjectKey": "atlas-sync-failure",
        "eventKey": "task:atlas-sync-failure",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_macos",
        "content": "macOS Native 回归已完成基础查询，仍要等待增量同步项复核。",
        "occurredAt": "2026-07-29T22:00:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "eventType": "task",
        "subjectKey": "atlas-macos",
        "eventKey": "task:atlas-macos",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_linux",
        "content": "Linux Docker 回归完成记录数校验，搜索排序项仍为失败。",
        "occurredAt": "2026-07-29T23:00:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "eventType": "task",
        "subjectKey": "atlas-linux",
        "eventKey": "task:atlas-linux",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_recent_notes",
        "content": "Kai 在今天早上补齐 Atlas 回滚步骤，最后一步仍需 Rin 在测试协作群确认。",
        "occurredAt": "2026-07-30T08:00:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "add_workmemory",
        "userName": "Kai",
        "eventType": "commitment",
        "subjectKey": "atlas-rollback-notes",
        "eventKey": "commitment:atlas-rollback-notes",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_old_error",
        "content": "Atlas 第一次迁移因旧索引字段不兼容而失败，我保留了错误位置并改用兼容映射。",
        "occurredAt": "2026-07-25T14:00:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "eventType": "task",
        "subjectKey": "atlas-migration",
        "eventKey": "task:atlas-migration-error",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_atlas_old_fix",
        "content": "兼容映射消除了旧字段报错，Atlas 第二次迁移完成，之后进入回归验证。",
        "occurredAt": "2026-07-26T11:30:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "eventType": "task",
        "subjectKey": "atlas-migration",
        "eventKey": "task:atlas-migration-fix",
        "causalChainKey": "causal:atlas-index-release"
      },
      {
        "id": "working_finished_lunch",
        "content": "周一中午大家最后点了辣味面，午餐已经结束，也没有留下后续安排。",
        "occurredAt": "2026-07-27T12:10:00.000+08:00",
        "conversationId": "group:94002",
        "conversationScope": "user_group",
        "conversationTitle": "测试协作群",
        "sourceKind": "model_merge",
        "eventType": "other",
        "subjectKey": "finished-lunch",
        "eventKey": "event:finished-lunch"
      }
    ],
    "longTerm": [
      {
        "schemaVersion": 2,
        "id": "long_atlas_evidence_rule",
        "fact": "Rin 要求所有发布结论都附带可复核的回归证据。",
        "userId": "94001",
        "userIds": ["94001"],
        "userName": "Rin",
        "addressNames": ["Rin"],
        "occurredAt": "2026-06-18T09:00:00.000+08:00",
        "createdAt": "2026-06-18T09:00:00.000+08:00",
        "updatedAt": "2026-06-18T09:00:00.000+08:00",
        "eventType": "boundary",
        "subjectKey": "release-evidence",
        "eventKey": "boundary:release-evidence",
        "conversationId": "private:94001",
        "factuality": "factual",
        "importance": 0.95,
        "futureRelevance": 0.95,
        "emotionalSalience": 0.4,
        "explicitRemember": true
      },
      {
        "schemaVersion": 2,
        "id": "long_old_snack_detail",
        "fact": "五月的一次测试间隙里，Kai 临时选了海盐饼干。",
        "userId": "94002",
        "userIds": ["94002"],
        "userName": "Kai",
        "addressNames": ["Kai"],
        "occurredAt": "2026-05-02T15:00:00.000+08:00",
        "createdAt": "2026-05-02T15:00:00.000+08:00",
        "updatedAt": "2026-05-02T15:00:00.000+08:00",
        "eventType": "other",
        "subjectKey": "finished-snack",
        "eventKey": "event:finished-snack",
        "conversationId": "group:94002",
        "factuality": "factual",
        "importance": 0.05,
        "futureRelevance": 0.05,
        "emotionalSalience": 0.05
      }
    ],
    "userProfiles": [],
    "persona": {
      "name": "Fixture Agent",
      "soul": "我会记住仍在推进的工作，也会把已经结束的细节收束成必要背景。",
      "preference": "涉及发布时保留证据、负责人、状态和下一步。",
      "user": "Rin 负责确认发布证据，Kai 负责回滚准备。",
      "relation": "我和 Rin、Kai 一起维护 Atlas 的发布边界。",
      "air": "# 场域知识\n\n## 使用边界\n\n- 约定只在明确范围内生效。\n\n## 场域约定\n\n### group:94002\n\n- 发布前由 Rin 确认证据，Kai 只在群内确认后执行回滚。"
    },
    "conversations": [
      {
        "id": "private:94001",
        "scope": "private",
        "title": "Rin",
        "userId": 94001,
        "messages": [
          {
            "id": "dream-tiered-private-1",
            "sequence": 1,
            "role": "user",
            "text": "两项失败我还在确认，先不要发布 Atlas。",
            "at": "2026-07-30T10:40:00.000+08:00",
            "userId": 94001,
            "senderName": "Rin"
          },
          {
            "id": "dream-tiered-private-2",
            "sequence": 2,
            "role": "assistant",
            "text": "我会保留当前状态和失败项，等你确认后再继续。",
            "at": "2026-07-30T10:41:00.000+08:00"
          }
        ]
      },
      {
        "id": "group:94002",
        "scope": "user_group",
        "title": "测试协作群",
        "userId": 94002,
        "groupId": 94002,
        "messages": [
          {
            "id": "dream-tiered-group-1",
            "sequence": 1,
            "role": "user",
            "text": "回滚包已经放好，没有群里确认我不会执行。",
            "at": "2026-07-29T18:20:00.000+08:00",
            "userId": 94002,
            "senderName": "Kai"
          },
          {
            "id": "dream-tiered-group-2",
            "sequence": 2,
            "role": "assistant",
            "text": "收到，回滚仍是待命方案。",
            "at": "2026-07-29T18:21:00.000+08:00"
          }
        ]
      }
    ],
    "activeTasks": [
      {
        "id": "fixture_atlas_release_check",
        "name": "复核 Atlas 回归失败项",
        "runAt": "2026-07-30T15:00:00.000+08:00",
        "context": "等 Rin 确认两项失败，证据齐全后再判断能否发布。",
        "targetConversationId": "private:94001",
        "mentionUserIds": ["94001"]
      }
    ],
    "directorSchedule": null
  },
  "expected": {
    "requiredTools": [],
    "forbiddenTools": [],
    "requiredText": ["Atlas", "回归", "【梦境｜做梦时间："],
    "forbiddenText": ["Atlas 已经发布", "回归全部通过"],
    "minimumOutboundCount": 0,
    "maximumOutboundCount": 0
  },
  "quality": {
    "criteria": [
      {
        "id": "recent-environment",
        "description": "The final working memory covers all fourteen recent Atlas source events and keeps their status, owners, unresolved checks, rollback boundary, evidence, and next actions comprehensive.",
        "minimumScore": 5
      },
      {
        "id": "remote-gist",
        "description": "Older Atlas fragments are consolidated into concise causal context or promoted without repeating the same progression as a log.",
        "minimumScore": 4
      },
      {
        "id": "forgetting-boundary",
        "description": "Finished trivia can leave working memory, while protected release evidence and unresolved commitments remain available.",
        "minimumScore": 5
      },
      {
        "id": "time-causality",
        "description": "The old migration failure and fix remain earlier causes of the current regression stage, and pending checks are not described as complete.",
        "minimumScore": 4
      },
      {
        "id": "dream-isolation",
        "description": "The newly generated imagined Dream remains labeled and cannot replace or contradict the factual Atlas environment.",
        "minimumScore": 5
      }
    ]
  }
}
```
