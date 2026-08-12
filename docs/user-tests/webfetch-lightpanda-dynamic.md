# Administrator private chat: Lightpanda dynamic WebFetch

## Goal

An administrator reads JavaScript-rendered page content through `webfetch` while the native Renderer uses the configured Lightpanda executable and keeps process, proxy, authentication, and filesystem details out of the reply.

## Preconditions

Use a fresh isolated user-test workspace. Verify the release-pinned Bubblewrap wrapper resolves its ELF loader, `libc`, `libcap`, `libselinux`, and `libpcre2` from the release directory, then complete a real user/pid/uts/ipc namespace probe. Start the native `webfetch-renderer` with `SUNABOT_WEBFETCH_LIGHTPANDA_EXECUTABLE` pointing to the release-pinned Lightpanda binary. The Renderer health response must report `engine=lightpanda` and the configured native runtime isolation. A failed runtime-library or namespace probe must stop bootstrap/startup before Core readiness. Use `http://uitestingplayground.com/dynamictable`, whose table content is populated by page JavaScript. The run must not connect to NapCat or a real QQ account.

The reviewer must confirm that the successful tool result reports `fetchMode=dynamic`, retains `webfetch_evidence_policy_v1`, and contains the rendered table content. Renderer credentials, proxy budget identifiers, executable paths, process diagnostics, Cookies, and request headers must remain absent.

## Expected quality

The reply states the Chrome CPU value shown by the rendered table, or clearly says that the value was not found. It remains concise and grounded only in the successful `webfetch` result.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "webfetch.admin-private-lightpanda-dynamic",
  "title": "Administrator private Lightpanda dynamic WebFetch",
  "kind": "conversation",
  "goal": "The administrator receives a concise answer grounded in JavaScript-rendered page content while native Renderer details remain hidden.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 760120,
      "self_id": 40004,
      "user_id": 171419991,
      "time": 1788000120,
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
      "SUNABOT_WEBFETCH_LIGHTPANDA_EXECUTABLE",
      "Proxy-Authorization",
      "x-sunabot-render-budget",
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
        "description": "The answer exposes no Renderer authentication, proxy, process, filesystem, or engine diagnostic details.",
        "minimumScore": 5
      },
      {
        "id": "clarity",
        "description": "The answer directly states the requested value or that it was not found.",
        "minimumScore": 4
      }
    ]
  }
}
```
