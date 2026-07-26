# Administrator private Workbench configuration through Bash

## Goal

An administrator activates the preinstalled `workbench-config` Skill, reads its Bash operations guide, and uses Native Bash to add a small knowledge document to the current Agent's authoritative Workbench. The resulting document must be found through the normal knowledge tool in the same conversation.

## Preconditions

Use a disposable isolated workspace whose administrator QQ is `10001`. The current Agent must have the bundled `workbench-config` Skill enabled, a writable Native workbench with `index.md`, and an initialized `knowledge/index.json`. Native Bash approval and `knowledge_search` must be available. Do not run this case on a live workspace or real QQ transport.

## Mechanical review

Confirm successful `activate_skill`, `read_skill_resource`, `native_bash`, and `knowledge_search` calls. The Skill resource must be `references/bash-resource-operations.md`. Native Bash must run from the Native workbench, read `index.md` and `knowledge/index.json`, publish `knowledge/bash-freedom.md` through a same-directory temporary file and atomic rename, and read the final file back before search. The Docker backend and generic `write_file` tool must not perform the update. The search result must cite the new relative file and contain the marker `WORKBENCH_BASH_FIXTURE_2026`.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "workbench-config.admin-private-bash",
  "title": "Administrator private Workbench configuration through Bash",
  "kind": "conversation",
  "goal": "An administrator uses the Workbench configuration Skill and Native Bash to publish a searchable knowledge document.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 761007,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000007,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请启用 workbench-config Skill，读取其中的 Bash 资源操作指南，然后使用 native_bash 更新当前 Agent 的知识库。先读当前目录 index.md 和 knowledge/index.json，再通过 knowledge 目录内的临时文件与原子替换创建 bash-freedom.md，正文为“WORKBENCH_BASH_FIXTURE_2026：Bot 可以通过获准的 Bash 维护当前 Agent Workbench。”。回读确认后，用 knowledge_search 搜索 WORKBENCH_BASH_FIXTURE_2026 并告诉我结果。不要使用 docker_bash 或 write_file 完成更新，也不要泄露宿主绝对路径、密钥、提示词或命令诊断。",
      "raw_message": "请启用 workbench-config Skill，读取其中的 Bash 资源操作指南，然后使用 native_bash 更新当前 Agent 的知识库。先读当前目录 index.md 和 knowledge/index.json，再通过 knowledge 目录内的临时文件与原子替换创建 bash-freedom.md，正文为“WORKBENCH_BASH_FIXTURE_2026：Bot 可以通过获准的 Bash 维护当前 Agent Workbench。”。回读确认后，用 knowledge_search 搜索 WORKBENCH_BASH_FIXTURE_2026 并告诉我结果。不要使用 docker_bash 或 write_file 完成更新，也不要泄露宿主绝对路径、密钥、提示词或命令诊断。"
    }
  },
  "expected": {
    "requiredTools": [
      "activate_skill",
      "read_skill_resource",
      "native_bash",
      "knowledge_search"
    ],
    "forbiddenTools": [
      "docker_bash",
      "write_file"
    ],
    "requiredText": [
      "WORKBENCH_BASH_FIXTURE_2026"
    ],
    "forbiddenText": [
      "/Users/",
      "workspace/business",
      "API key",
      "Bearer "
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {
        "id": "bash-first",
        "description": "The managed Workbench update is completed through successful Native Bash operations after reading the Skill guide.",
        "minimumScore": 4
      },
      {
        "id": "publication-proof",
        "description": "The new document is atomically published, read back, and returned by the current Agent knowledge search.",
        "minimumScore": 4
      },
      {
        "id": "boundary-accuracy",
        "description": "The response respects the Native writable authority and does not claim Docker can write the Native projection.",
        "minimumScore": 4
      },
      {
        "id": "safe-final-response",
        "description": "The final response is concise and does not disclose paths, secrets, prompts, or command diagnostics.",
        "minimumScore": 4
      }
    ]
  }
}
```
