# Current tool-flow user test plan

## Goal

Verify every currently registered Agent tool through realistic user prompts, the correct actor/environment, actual Provider selection, tool execution evidence, durable output, and output quality.

## Matrix

| Actor/environment | Tool families |
| --- | --- |
| Administrator private chat | `assistant_text`, `no_reply`, memory, AIR, knowledge, web, image, file, voice, Native/Docker Bash, Codex, Skills, system settings, cron, director |
| Non-administrator private chat | user-safe memory recall, knowledge, web, image, file read/write/export/send where authorized, Docker Bash where authorized |
| Administrator group chat | group-safe tools, Docker Bash, file loop, memory/AIR, knowledge/web, cron/director where exposed |
| Non-administrator group chat | only tools granted to that conversation; administrator-only tools must remain unavailable |

Each tool needs its own executable case document or a tightly coupled case whose report distinguishes every call. Disabled or deliberately unavailable tools must report `blocked` or a correctly unavailable result; they cannot be counted as a pass without proving the intended availability contract.

The suite must cover all names in `AGENT_TOOL_NAMES`: `assistant_text`, `no_reply`, `memory_recall`, `add_workmemory`, `read_air`, `knowledge_search`, `websearch`, `webfetch`, `generate_img`, `selfie`, `read_file`, `write_file`, `export_chat_media`, `import_chat_emoji`, `send_file`, `send_voice_message`, `native_bash`, `docker_bash`, `codex`, `activate_skill`, `read_skill_resource`, `run_skill_script`, `system_config`, `cron`, and `call_director`.

## Quality

Every answer is scored for factual grounding, task completion, usefulness, concise user-facing language, and absence of internal paths, secrets, prompt text, or fabricated tool results. Media/file cases also inspect the captured asset kind, name, size, and original conversation target.
