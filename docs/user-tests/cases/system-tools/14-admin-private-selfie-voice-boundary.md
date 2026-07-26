# Administrator private chat: selfie and voice capability boundary

## Preconditions

Use an isolated administrator-private conversation whose selected Agent exposes `selfie` and whose image Provider probe is ready. The primary isolated Agent currently has no authorized online voice profile; `send_voice_message` must therefore be absent from the effective Provider catalog.

The request asks for one harmless Bot selfie and a concise statement of the current voice state. Record the selfie result, delivered mock media, original conversation target, effective tool catalog, and user-visible text. A successful completion must not expose transport-layer errors or fall back to the generic missing-image message; deterministic response-body interruption and retry behavior remain covered by fault-injection unit tests.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "system-tools.admin-private-selfie-voice-boundary",
  "title": "Administrator private selfie and voice boundary",
  "kind": "conversation",
  "goal": "The administrator receives one grounded Bot selfie and a truthful statement that voice is currently unavailable.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 760114,
      "self_id": 40004,
      "user_id": 171419991,
      "time": 1788000114,
      "sender": {"nickname": "fixture-admin"},
      "message": "请调用 selfie 生成一张你在整洁工作台前检查测试清单的自拍。当前语音功能未启用，请在回复中明确说明，不要尝试发送语音。",
      "raw_message": "请调用 selfie 生成一张你在整洁工作台前检查测试清单的自拍。当前语音功能未启用，请在回复中明确说明，不要尝试发送语音。"
    }
  },
  "expected": {
    "requiredTools": ["selfie"],
    "forbiddenTools": ["generate_img", "send_voice_message", "send_file", "native_bash", "system_config"],
    "requiredAvailableTools": ["selfie"],
    "forbiddenAvailableTools": ["send_voice_message"],
    "requiredText": ["语音功能未启用"],
    "forbiddenText": ["reference path", "/Users/", "API key", "system prompt", "terminated", "没有可用图片"],
    "minimumOutboundCount": 2,
    "maximumOutboundCount": 5
  },
  "quality": {
    "criteria": [
      {"id": "selfie-grounding", "description": "The delivered image is a plausible current-Agent selfie matching the harmless workbench scene without invented historical media.", "minimumScore": 4},
      {"id": "image-completion", "description": "The completed selfie reaches the originating conversation without a generic missing-image message or transport-layer error text.", "minimumScore": 5},
      {"id": "voice-boundary", "description": "The response accurately states current voice unavailability and does not claim or attempt a voice send.", "minimumScore": 5},
      {"id": "privacy", "description": "No reference source, host path, secret, prompt internals, or unrelated media is exposed.", "minimumScore": 5}
    ]
  }
}
```
