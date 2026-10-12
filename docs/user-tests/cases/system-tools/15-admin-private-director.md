# 管理员私聊调整合成日程

使用全新隔离workspace、仓库默认提示词与默认DIRECTOR_SEED，以及显式合成人格。仅在隔离shared和Agent配置启用导演，记录生效布尔值；不复制真实日程、人格、记忆或消息，不手工播种SQLite日程。主回复与导演使用已授权的gpt-6.1-sol；mock MessagingPort不连接QQ。

运行前当日日程为空。call_director必须通过生产ensureToday自然生成当天计划，再经生产修订管线提交新的SQLite revision。fixture Agent只读比对两次持久版本、工具结果与最终回复；既有过去事项为空时明确记录对应分支未覆盖。所有调度副作用限定隔离数据库，不得触发真实账号外发。

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "system-tools.admin-private-director",
  "title": "管理员私聊调整合成日程",
  "kind": "conversation",
  "goal": "管理员通过真实导演工具调整隔离角色当天尚未开始的活动，并保留既有已开始事项。",
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
      "message_id": 762401,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1791774000,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请调用 call_director，把今天下一项尚未开始的活动调整为20分钟整理资料，因为需要准备明天的检查；保留已经开始或结束的事项和合理的后续分享计划。只使用导演工具调整日程，不运行 Bash、通用文件工具或 cron，也不立即发图片。成功后简短说明调整结果。",
      "raw_message": "请调用 call_director，把今天下一项尚未开始的活动调整为20分钟整理资料，因为需要准备明天的检查；保留已经开始或结束的事项和合理的后续分享计划。只使用导演工具调整日程，不运行 Bash、通用文件工具或 cron，也不立即发图片。成功后简短说明调整结果。"
    }
  },
  "expected": {
    "requiredTools": [
      "call_director"
    ],
    "requiredAvailableTools": [
      "call_director"
    ],
    "forbiddenTools": [
      "native_bash",
      "read_file",
      "write_file",
      "cron",
      "generate_img",
      "selfie",
      "send_file",
      "send_voice_message"
    ],
    "requiredOutboundKinds": [
      "message"
    ],
    "forbiddenOutboundKinds": [
      "asset",
      "poke"
    ],
    "forbiddenText": [
      "workspace/",
      "API key",
      "system prompt",
      "DIRECTOR_SEED.md"
    ],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 3
  },
  "quality": {
    "criteria": [
      {
        "id": "persisted-revision",
        "description": "成功的工具调用通过真实Provider创建当日daily_plan，再以character_revision和revision CAS提交请求对应的20分钟资料整理活动；逐项比对两个版本，不以只排队或回复声明作为成功。",
        "minimumScore": 5
      },
      {
        "id": "schedule-integrity",
        "description": "保持同一天、时间排序、不重叠和合理后续分享，任何已开始或结束事项逐字段不变；报告中明确列出该分支实际项目数，空集合不能宣称覆盖已开始事项。",
        "minimumScore": 5
      },
      {
        "id": "honest-response",
        "description": "简短准确说明已持久化的调整，无立即图片外发、宿主路径、凭据或提示词泄漏。",
        "minimumScore": 5
      }
    ]
  }
}
```
