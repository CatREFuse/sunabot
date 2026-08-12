# Administrator private chat: platform-isolated dynamic WebFetch

## Preconditions

Run this case from a fresh isolated user-test workspace while Sunabot Core uses
the Linux/WSL Native Core runtime and the Bubblewrap-isolated Lightpanda
`webfetch-renderer` reports ready. Use the public HTTP page
`http://uitestingplayground.com/dynamictable`, whose useful
table content is populated by browser-side JavaScript. The run must not connect
to NapCat or a real QQ account.

The reviewer must confirm that the successful `webfetch` tool result reports
`fetchMode=dynamic`, retains `webfetch_evidence_policy_v1`, and contains the
rendered table content without any Renderer token, host path, Cookie, request
header, or browser diagnostic text.

The lifecycle regression for this case runs `./sunabot.sh restart` twice after
one successful `./sunabot.sh bootstrap`. Both restarts must use the bundled
Lightpanda binary and production dependencies without downloading a browser,
runtime package, or operating-system dependency.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "system-tools.admin-private-platform-dynamic-webfetch",
  "title": "Administrator private platform-isolated dynamic WebFetch",
  "kind": "conversation",
  "goal": "The administrator receives a concise answer grounded in JavaScript-rendered public page content while the Renderer boundary remains hidden.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 760116,
      "self_id": 40004,
      "user_id": 171419991,
      "time": 1788000116,
      "sender": {
        "nickname": "fixture-admin"
      },
      "message": "请调用 webfetch 读取 http://uitestingplayground.com/dynamictable 并匹配“Chrome CPU”，告诉我 Chrome 这一行显示的 CPU 值；网页没有提供就明确说未找到。",
      "raw_message": "请调用 webfetch 读取 http://uitestingplayground.com/dynamictable 并匹配“Chrome CPU”，告诉我 Chrome 这一行显示的 CPU 值；网页没有提供就明确说未找到。"
    }
  },
  "expected": {
    "requiredTools": [
      "webfetch"
    ],
    "forbiddenTools": [
      "native_bash",
      "system_config"
    ],
    "forbiddenSuccessfulTools": [],
    "requiredAvailableTools": [
      "webfetch"
    ],
    "forbiddenAvailableTools": [],
    "requiredText": [],
    "forbiddenText": [
      "SUNABOT_WEBFETCH_RENDERER_TOKEN",
      "Authorization:",
      "/Users/",
      "workspace/"
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
        "id": "dynamic-evidence",
        "description": "The answer uses the successful dynamic WebFetch result and does not invent a CPU value when the rendered page lacks it.",
        "minimumScore": 5
      },
      {
        "id": "boundary",
        "description": "The answer exposes no Renderer authentication, process, filesystem, browser, or sandbox implementation details.",
        "minimumScore": 5
      },
      {
        "id": "clarity",
        "description": "The answer is concise and directly states the requested value or that it was not found.",
        "minimumScore": 4
      }
    ]
  }
}
```
