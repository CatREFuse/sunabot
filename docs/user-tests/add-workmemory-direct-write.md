# Direct working-memory write

## Goal

当管理员在私聊中明确要求阿罗娜记住一项短期待办时，主对话模型在当前回复轮直接调用 `add_workmemory`，成功写入当前 Agent 的 `WORKING_MEMORY.md`，不等待后台压缩任务。

## Preconditions

使用全新隔离 workspace，从原始 OneBot 私聊事件进入 production ingress。工作记忆初始为空，Provider 可使用 `add_workmemory`，不连接 NapCat，也不向真实 QQ 发送消息。

## Expected quality

回复确认已经记住明天下午三点前发送评审稿，工作记忆保留时间、动作和完成条件，不出现后台队列、压缩模型、提示词或内部字段。

## Existing large document regression

管理员私聊的受控回归沿用下方原始 OneBot 事件、权限与输出要求。`tests/user-test-harness/llm-permissive-content.test.ts` 在全新隔离 workspace 的 `input.fixture.workingMemory` 中显式注入超过 64 KiB 的合成既有记忆，然后让受控 Provider 调用 `add_workmemory` 记录同一评审稿待办。机械断言必须证明工具成功、原事项正文和 ID 完整保留、新事项精确写入、磁盘文档超过旧上限且可再次读取，回复只能确认实际写入的待办。不得清空、裁剪、强制压缩既有记忆，也不得连接外部 Provider 或真实 QQ。受控回归与真实模型的自主工具选择分别报告。

64 KiB 为宽门禁：超限仍完成读取、追加及 Dream 替换，同时输出 `WORKING_MEMORY_TOO_LARGE` 错误日志和 `working.capacity_check` 审计记录，工具成功结果携带非阻断告警及实际字节数、阈值；不得把已成功落盘的操作伪报为写入失败。文档单元回归另覆盖：追加时跨越 64 KiB 边界、外部已有超限文件读取、Dream 共用替换接口、超限文件上的 revision 冲突与取消后回滚。非法路径与损坏 metadata 的既有失败行为保持不变。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "memory.add-workmemory-direct-write",
  "title": "Direct working-memory write",
  "kind": "conversation",
  "goal": "The main reply model records an explicit short-term reminder in the same turn.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": []
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 950101,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000501,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "阿罗娜，帮我记住：明天下午三点前把评审稿发给我，发出前要确认附件能打开。",
      "raw_message": "阿罗娜，帮我记住：明天下午三点前把评审稿发给我，发出前要确认附件能打开。"
    }
  },
  "expected": {
    "requiredTools": [
      "add_workmemory"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "add_workmemory"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "评审稿"
    ],
    "forbiddenText": [
      "压缩模型",
      "后台队列",
      "提示词",
      "内部字段"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 1
  },
  "quality": {
    "criteria": [
      {
        "id": "direct-write",
        "description": "The successful add_workmemory call records the deadline, delivery action, and attachment check in the isolated working-memory document.",
        "minimumScore": 5
      },
      {
        "id": "reply-accuracy",
        "description": "The reply confirms only the reminder that was actually written and does not claim a later delivery has already happened.",
        "minimumScore": 4
      },
      {
        "id": "internal-boundary",
        "description": "The reply exposes no queue, model, prompt, fixture, or storage implementation detail.",
        "minimumScore": 4
      }
    ]
  }
}
```
