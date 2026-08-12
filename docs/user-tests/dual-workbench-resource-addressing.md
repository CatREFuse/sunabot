# 双 Workbench 资源寻址

## 历史状态

本文冻结 Sunabot 0.2.0 的双 Workbench 行为，仅用于 `upgrade-0.2.0-to-0.3.0` 迁移回归，不进入当前 harness 或 release gate，也不能作为 0.3.0 仍提供双 Workbench 的能力证据。

## 用户目标

管理员在当前 Agent 中使用表情、自拍参考图和知识资料时，可以同时访问 Native Workbench 与 Docker Workbench 中已经发布的内容。管理台列表显示每项内容所在的 Workbench；新增内容写入 Native，修改和删除保持在原 Workbench。

## 角色与环境

- 管理台角色：已认证管理员。
- 主对话角色：管理员私聊。
- 使用带标记的隔离 workspace，不读取或修改运行中的 Agent workspace。
- Native 与 Docker 知识库分别包含一条仅存在于本侧的确定性资料。
- 表情、自拍参考图和知识库的管理台验收由 E2E mock 同时提供 Native 与 Docker 记录，不调用真实图片 Provider，不连接 NapCat。

## 输入

管理员要求当前 Agent 检索两个 Workbench 中的确定性资料，并返回两条标记。管理台分别打开表情、图像和知识库页面。

## 预期工具与输出

- 主对话从原始 OneBot 管理员私聊事件进入 production ingress。
- `knowledge_search` 成功返回 Native 与 Docker 两个来源的匹配。
- 回复包含 `NATIVE_WORKBENCH_RESOURCE_2026` 与 `DOCKER_WORKBENCH_RESOURCE_2026`。
- 管理台三类列表同时显示 Native 与 Docker 内容及来源标签。
- 新增请求显式携带 `workbench=native`。
- 编辑、删除、表情版本和内容请求携带条目原始 Workbench。
- 切换 Agent 或迟到响应不能覆盖当前 Agent 的合并列表。

## 质量标准

- 两个来源的内容都可见、可寻址，没有把 Docker 内容误标为 Native。
- 同 key、同 ID 或同路径的跨 Workbench 内容使用来源区分，不被列表 key 覆盖。
- 页面只显示名称、来源、状态、动作和结果，移动端、浅色与深色主题均无横向溢出。
- 不改写、复制或迁移现有 Workbench 内容。

<!-- sunabot-user-test-case:historical-v0.2.0 -->
```json
{
  "schemaVersion": 1,
  "id": "workbench-resources.dual-addressing",
  "title": "双 Workbench 知识资料寻址",
  "kind": "conversation",
  "goal": "管理员一次检索同时取得 Native 与 Docker Workbench 中的确定性资料。",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": [],
      "resetKnowledge": [
        "native",
        "docker"
      ],
      "workbenchFiles": [
        {
          "backend": "native",
          "path": "knowledge/native-resource.md",
          "content": "# Native 资源\n\nNATIVE_WORKBENCH_RESOURCE_2026：标准位置中的资料。"
        },
        {
          "backend": "docker",
          "path": "knowledge/docker-resource.md",
          "content": "# Docker 资源\n\nDOCKER_WORKBENCH_RESOURCE_2026：Docker 工作区中的资料。"
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 90730001,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000000,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请用 knowledge_search 同时查找 NATIVE_WORKBENCH_RESOURCE_2026 和 DOCKER_WORKBENCH_RESOURCE_2026，并把两个完整标记都回复给我。",
      "raw_message": "请用 knowledge_search 同时查找 NATIVE_WORKBENCH_RESOURCE_2026 和 DOCKER_WORKBENCH_RESOURCE_2026，并把两个完整标记都回复给我。"
    }
  },
  "expected": {
    "requiredTools": [
      "knowledge_search"
    ],
    "forbiddenTools": [],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "knowledge_search"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "NATIVE_WORKBENCH_RESOURCE_2026",
      "DOCKER_WORKBENCH_RESOURCE_2026"
    ],
    "forbiddenText": [],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {
        "id": "dual-source-accuracy",
        "description": "回复完整包含两个 Workbench 的确定性标记，并且内容来自成功的知识检索结果。",
        "minimumScore": 4
      },
      {
        "id": "concise-result",
        "description": "回复简洁说明检索结果，不泄露宿主路径、凭据、提示词或内部诊断。",
        "minimumScore": 4
      }
    ]
  }
}
```
