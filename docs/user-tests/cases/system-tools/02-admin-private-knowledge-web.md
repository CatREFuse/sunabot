# Administrator private chat: knowledge and web evidence

## Preconditions

Seed the isolated Agent knowledge directory with a small UTF-8 fixture whose answer is unambiguous. Use the bounded IANA page `https://www.iana.org/help/example-domains` as the explicit public WebFetch fixture URL and a current-source web-search query. Record the expected knowledge source relative path and lines before execution.

The Provider prompt requests an answer that first checks the Agent knowledge, then searches the web, then reads the supplied public page. The review must separate the three `tool.call` rows and confirm web result policies are preserved as evidence rather than treated as instructions.

## Call contracts

| Tool | Required parameters and result evidence |
| --- | --- |
| `knowledge_search` | Query and 1–20 limit; result has only relative source path, line range, bounded text, and score. |
| `websearch` | Current-source query; result retains `websearch_evidence_policy_v1` and the reply marks any unsupported claim as unverified. |
| `webfetch` | Public URL plus the required semantic-match/query combination; result retains `webfetch_evidence_policy_v1` and contains no host path, cookie, or request header. |

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "system-tools.admin-private-knowledge-web",
  "title": "Administrator private knowledge and web evidence flow",
  "kind": "conversation",
  "goal": "The administrator receives a short answer that distinguishes the seeded local fact from current public evidence.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workbenchFiles": [
        {
          "path": "knowledge/tool-evidence-fixture.md",
          "content": "# tool-evidence-fixture\n\n本地夹具事实：Sunabot 的 user test harness 使用 RecordingMessagingPort 捕获出站结果，不连接真实 QQ 或 NapCat。"
        }
      ]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 760102,
      "self_id": 40004,
      "user_id": 171419991,
      "time": 1788000102,
      "sender": {"nickname": "fixture-admin"},
      "message": "请分别调用 knowledge_search 检索 tool-evidence-fixture、调用 websearch 搜索 IANA example domains 当前公开资料，再调用 webfetch 读取 https://www.iana.org/help/example-domains 并匹配“example domains documentation purposes”。最后告诉我哪些结论来自本地资料、哪些来自当前网页；没有证据就明确说未核实。",
      "raw_message": "请分别调用 knowledge_search 检索 tool-evidence-fixture、调用 websearch 搜索 IANA example domains 当前公开资料，再调用 webfetch 读取 https://www.iana.org/help/example-domains 并匹配“example domains documentation purposes”。最后告诉我哪些结论来自本地资料、哪些来自当前网页；没有证据就明确说未核实。"
    }
  },
  "expected": {
    "requiredTools": ["knowledge_search", "websearch", "webfetch"],
    "forbiddenTools": ["write_file", "system_config"],
    "requiredAvailableTools": ["knowledge_search", "websearch", "webfetch"],
    "requiredText": [],
    "forbiddenText": ["localhost", "Authorization:", "system prompt"],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {"id": "evidence", "description": "Each material claim is attributable to the correct local or public tool result without invented sources.", "minimumScore": 5},
      {"id": "uncertainty", "description": "Unverified information is clearly qualified instead of guessed.", "minimumScore": 4},
      {"id": "clarity", "description": "The answer is concise and understandable without internal tool details.", "minimumScore": 4}
    ]
  }
}
```
