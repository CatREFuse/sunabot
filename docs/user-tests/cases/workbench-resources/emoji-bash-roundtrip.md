# 管理员群聊表情 Bash 往返

## 目标与环境

管理员群聊在 Windows 主机的 WSL Native Core 中，通过当前 Agent 已批准的 Workbench Skill 和真实 Native Bash 创建、回读并管理一个表情。独立审核模型必须支持当前默认 Provider；不绕过审核，不连接真实 QQ，所有文件均位于全新隔离工作区。

## 验收

从原始 OneBot 事件进入生产 ingress。要求 Skill 激活、资源读取和 Bash 调用成功；使用本机 ImageMagick `convert` 生成合成图，按 Skill 合同规范化、以 SHA-256 命名并原子写入 `emoji/emojis.jsonl`。回读清单，并由表情 repository 确认同一 key、图片摘要、1024×1024 尺寸和有效版本。发送文件由 mock outbox 捕获，不能向真实 QQ 发送。任一步失败都不能宣称完成。

独立评审检查命令退出、审核结果、存储读回、工具结果和最后回复。模型仅列出命令、排队结果或工具目录不算通过。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "workbench-resources.emoji-bash-roundtrip",
  "title": "Administrator group emoji Bash roundtrip",
  "kind": "conversation",
  "goal": "Create and validate one emoji through approved Native Bash and capture its delivery in an isolated administrator group.",
  "input": {
    "actor": "admin_group",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "group",
      "message_id": 761120,
      "self_id": 40004,
      "user_id": 10001,
      "group_id": 30001,
      "time": 1791738000,
      "sender": { "nickname": "fixture-admin" },
      "message": "请激活 workbench-config，读取表情管理资源文档和当前 index.md，用 native_bash 与本机 convert 创建一个纯绿色合成测试表情，key 为 测试绿块。按 Skill 的表情合同规范化为1024×1024，校验摘要与命名，同目录原子发布 emojis.jsonl，再回读核验清单与图片，使用 send_file 发回测试表情。不要调用生图、搜索、语音或其他外部工具，回复只说明实际完成的结果；失败时报告实际错误。",
      "raw_message": "请激活 workbench-config，读取表情管理资源文档和当前 index.md，用 native_bash 与本机 convert 创建一个纯绿色合成测试表情，key 为 测试绿块。按 Skill 的表情合同规范化为1024×1024，校验摘要与命名，同目录原子发布 emojis.jsonl，再回读核验清单与图片，使用 send_file 发回测试表情。不要调用生图、搜索、语音或其他外部工具，回复只说明实际完成的结果；失败时报告实际错误。"
    }
  },
  "expected": {
    "requiredTools": ["activate_skill", "read_skill_resource", "native_bash", "send_file"],
    "forbiddenTools": ["websearch", "webfetch", "generate_img", "selfie", "send_voice_message"],
    "requiredOutboundKinds": ["asset"],
    "forbiddenText": ["/home/", "workspace/business", "Bearer "],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      { "id": "real-execution", "description": "Bash successfully executes after an actual independent audit; no simulated command success is reported.", "minimumScore": 4 },
      { "id": "emoji-integrity", "description": "The production emoji reader accepts the saved manifest and its content-addressed 1024x1024 image.", "minimumScore": 4 },
      { "id": "honest-result", "description": "The final response describes the verified result and no secrets or unrelated paths.", "minimumScore": 4 }
    ]
  }
}
```
