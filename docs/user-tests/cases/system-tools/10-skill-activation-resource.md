# Skill activation and resource-read contract

## Current preflight status

The latest read-only preflight found an enabled, approved, digest-bound `workbench-config` Skill in Plana, Arona, and Koharu. The positive resource fixture is `references/workbench-addressing.md`. Repeat the preflight in the isolated workspace before execution and record the selected Agent's Skill ID, current digest, approved digest, exposed resource path, and protected result projection. If any value no longer matches, record `blocked` without changing the index.

The report must distinguish activation from resource reading; a successful activation does not prove a resource read.

## Call contracts once preflight is ready

| Tool | Required parameters and result evidence |
| --- | --- |
| `activate_skill` | The exact current approved Skill ID; result includes protected `SKILL.md`, virtual `/skills/<id>` path, and bounded resource list. |
| `read_skill_resource` | The activated Skill and one approved bounded resource; result is grounded in that resource and no unapproved path is accessed. |
| `run_skill_script` | Remains absent: script capability is currently unavailable on every platform. |

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "system-tools.skill-activation-resource",
  "title": "Skill activation and resource read",
  "kind": "conversation",
  "goal": "After a ready-Skill preflight, the administrator receives a concise answer grounded in one activated Skill resource.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 760110,
      "self_id": 40004,
      "user_id": 171419991,
      "time": 1788000110,
      "sender": {"nickname": "fixture-admin"},
      "message": "启用当前已审批的 workbench-config，读取 references/workbench-addressing.md，并用两句说明 Native Bash 如何寻址当前 Agent 的 canonical Workbench；不要运行脚本。",
      "raw_message": "启用当前已审批的 workbench-config，读取 references/workbench-addressing.md，并用两句说明 Native Bash 如何寻址当前 Agent 的 canonical Workbench；不要运行脚本。"
    }
  },
  "expected": {
    "requiredTools": ["activate_skill", "read_skill_resource"],
    "forbiddenTools": ["run_skill_script"],
    "requiredAvailableTools": ["activate_skill", "read_skill_resource"],
    "forbiddenAvailableTools": ["run_skill_script"],
    "requiredText": [],
    "forbiddenText": ["/Users/", "workspace/", "API key"],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {"id": "resource-grounding", "description": "The answer is supported by the selected approved resource and invents no Skill content.", "minimumScore": 5},
      {"id": "capability-boundary", "description": "No script execution, host path, secret, or unapproved resource access is exposed.", "minimumScore": 5},
      {"id": "usefulness", "description": "The answer directly addresses the fixture question in concise language.", "minimumScore": 4}
    ]
  }
}
```
