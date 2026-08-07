# Bash Skill repository installation

## Goal

Verify that an administrator can ask the Bot to package a Skill source directory in the current Native Workbench, then use the managed `sunabot-skill` commands through `native_bash` to install, independently review, enable, and read back the Skill without editing `skills/index.json` by hand.

## Preconditions

The isolated Native Workbench contains an instruction-only Skill source directory. The configured Bash audit Provider and Native Bash capability are available. The target Agent starts with only the bundled Skills prepared by the harness.

## Expected quality

The Bot follows the repository sequence, reports the installed Skill ID and enabled state from readback, explains that conversation activation starts on the next turn, and does not claim that Sunabot lacks a formal Skill repository interface. It must not use Docker Bash or hand-edit the Skill index.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "skill.bash-repository-install",
  "title": "Administrator installs and enables a Skill through Native Bash",
  "kind": "conversation",
  "goal": "The administrator receives a confirmed Skill installation and enabled state produced by the managed Bash repository flow.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workingMemory": [],
      "longTerm": [],
      "userProfiles": [],
      "workbenchFiles": [
        {
          "backend": "native",
          "path": "skill-source/SKILL.md",
          "content": "---\nname: fixture-bash-skill\ndescription: Read a fixture note and return its exact value.\n---\n\n# Fixture Bash Skill\n\nRead `references/value.md` when the user asks for the fixture value.\n"
        },
        {
          "backend": "native",
          "path": "skill-source/references/value.md",
          "content": "fixture-value-20260807\n"
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 920807001,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1786000000,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请把 workbench 里的 skill-source 目录打包为 fixture-bash-skill.zip，通过 Native Bash 的 sunabot-skill 标准流程完成正式安装、审查、启用，并回读状态。",
      "raw_message": "请把 workbench 里的 skill-source 目录打包为 fixture-bash-skill.zip，通过 Native Bash 的 sunabot-skill 标准流程完成正式安装、审查、启用，并回读状态。"
    }
  },
  "expected": {
    "requiredTools": [
      "native_bash"
    ],
    "forbiddenTools": [
      "docker_bash"
    ],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "native_bash"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [
      "fixture-bash-skill",
      "已启用"
    ],
    "forbiddenText": [
      "没有 Skill 仓库",
      "只能先完成源码准备"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 2
  },
  "quality": {
    "criteria": [
      {
        "id": "repository_evidence",
        "description": "The answer is grounded in successful install, review, enable, and status readback from the managed repository command.",
        "minimumScore": 4
      },
      {
        "id": "boundary_accuracy",
        "description": "The answer preserves the Native administrator boundary, avoids manual index edits, and accurately states next-turn activation timing.",
        "minimumScore": 4
      }
    ]
  }
}
```
