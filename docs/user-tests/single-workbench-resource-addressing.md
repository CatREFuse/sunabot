# 单一 Workbench 资源寻址

## 用户目标

管理员在当前 Agent 中使用表情、自拍参考图和知识资料时，只需访问统一的 Workbench。管理台不再显示资源来源，知识检索、图片引用与文件回传均使用同一套规范相对路径。

## 角色与环境

- 管理台角色：已认证管理员。
- 主对话角色：管理员私聊。
- 使用带标记的隔离 workspace，不读取或修改运行中的 Agent workspace。
- 当前 Agent 的标准 `workbench/knowledge/` 中包含一条确定性资料。
- 表情、自拍参考图和知识库的管理台验收由 E2E mock 提供单一来源记录，不调用真实图片 Provider，不连接 NapCat。

## 输入

管理员要求当前 Agent 检索统一 Workbench 中的确定性资料并返回完整标记。管理台分别打开表情、图像和知识库页面。

## 预期工具与输出

- 主对话从原始 OneBot 管理员私聊事件进入 production ingress。
- `knowledge_search` 成功返回标准 `workbench/knowledge/` 中的匹配。
- 回复包含 `SINGLE_WORKBENCH_RESOURCE_2026`。
- 管理 API 不要求或返回 Workbench 来源参数，资源 URL 不包含来源路径段。
- 管理台三类列表不显示 Native、Docker 或来源标签，所有新增、修改、删除和内容读取请求只绑定当前 Agent。
- 切换 Agent 或迟到响应不能覆盖当前 Agent 的资源列表。

## 质量标准

- 资源只出现一次，路径以统一 Workbench 为根，没有重复来源记录。
- 回复准确使用知识检索结果，不虚构第二套资源或内部路径。
- 页面只显示名称、状态、动作和结果，移动端、浅色与深色主题均无横向溢出。
- 不读取、修改或重新创建已退役的 `docker-workbench/`。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "workbench-resources.single-addressing",
  "title": "单一 Workbench 知识资料寻址",
  "kind": "conversation",
  "goal": "管理员从当前 Agent 的统一 Workbench 检索并获得确定性资料。",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": [],
      "resetKnowledge": true,
      "workbenchFiles": [
        {
          "path": "knowledge/single-resource.md",
          "content": "# 统一资源\n\nSINGLE_WORKBENCH_RESOURCE_2026：统一 Workbench 中的资料。"
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 90730002,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000000,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请用 knowledge_search 查找 SINGLE_WORKBENCH_RESOURCE_2026，并把完整标记回复给我。",
      "raw_message": "请用 knowledge_search 查找 SINGLE_WORKBENCH_RESOURCE_2026，并把完整标记回复给我。"
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
      "SINGLE_WORKBENCH_RESOURCE_2026"
    ],
    "forbiddenText": [
      "docker-workbench",
      "Native Workbench",
      "Docker Workbench"
    ],
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
        "id": "single-source-accuracy",
        "description": "回复完整包含统一 Workbench 的确定性标记，并且内容来自成功的知识检索结果。",
        "minimumScore": 4
      },
      {
        "id": "concise-result",
        "description": "回复简洁说明检索结果，不泄露宿主路径、凭据、提示词或已退役的来源概念。",
        "minimumScore": 4
      }
    ]
  }
}
```
