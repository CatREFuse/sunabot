# Workbench Addressing

## Authority Model

Each Agent has one canonical Workbench tree:

`workspace/business/agents/{agentId}/workbench/`

It contains the fixed entries for Skills, selfie references, emoji, and knowledge. `native_bash` starts inside the authorized view of this same tree. Do not infer a second root from the operating system, conversation type, or an old path.

## Runtime Path

Use `pwd -P` as the current command's authoritative Workbench path. The host path may be the Agent's canonical `workbench/`; an isolated runtime may expose the same root as `/workbench`. Both views address the same Agent resource tree.

Do not use or create a second Workbench or legacy projection. A path under another Agent or outside the current root is unavailable.

## Fixed Entries

Read the fixed entry before other files in the directory.

| Resource | Canonical entry |
| --- | --- |
| Current Workbench | `index.md` |
| Skills | `skills/index.json` |
| MCP | `../extensions/mcp/servers.json` through its repository, or the runtime's read-only MCP projection |
| Selfie references | `selfie/references.jsonl` |
| Emoji | `emoji/emojis.jsonl` |
| Knowledge | `knowledge/index.json` |

An entry that is missing, invalid, or points to absent content is a blocking configuration error. Report its resource type and directory. Do not scan neighboring directories to guess a replacement.

## Permission Contract

`native_bash` is usable only when it appears in the current turn's tool catalog. Its approval and isolation policy remains authoritative for the current conversation. This Skill cannot expose the tool, widen its path, or grant an administrator-only import operation.

`import_chat_emoji` and `import_chat_selfie` publish to the current Agent's canonical catalogs when present. Ordinary conversations may export bound media or return authorized task artifacts only through the tools exposed in that turn.

## Publication Routes

### Chat media

Use `export_chat_media` only with media bound to the current turn or an explicit quoted-message handle. The publisher verifies Agent, conversation, turn, media type, extension, byte count, SHA-256, and image dimensions. Output names use:

`chat-media-{sha256}.{ext}`

Do not provide arbitrary URLs, source paths, destination paths, or Agent IDs to substitute for a bound handle.

### Emoji

`native_bash` may maintain an already validated local emoji asset and the canonical `emoji/emojis.jsonl` through the atomic JSONL module. For current chat media, use `export_chat_media` to obtain verified bytes, or use `import_chat_emoji` when exposed to normalize and publish in one operation.

Stored content uses:

`emoji-{sha256}.png`

or:

`emoji-{sha256}.gif`

The importer validates format, pixels, size, normalizes content where required, deduplicates by content, and atomically replaces `emojis.jsonl` under a serialized update. Repeating the same key and content digest is idempotent. A `native_bash` update must preserve the same record schema, limits, content-addressed name, file validation, digest compare, and atomic readback.

### Skills

Use `native_bash` to inspect, author, edit, validate, hash, and archive a Skill source package in the canonical Workbench. Runtime activation still requires publication through the Skill repository under `workbench/skills/`, where packages are tied to their digest, reviewed digest, index revision compare-and-swap, transaction journal, and atomic directory/index publication. Never mint approval fields or reuse approval from an older digest.

### Selfie and knowledge resources

`native_bash` may add, update, and remove selfie assets and knowledge source files inside the canonical Workbench. Preserve the exact selfie JSONL schema and atomically replace `references.jsonl`; write knowledge source files with the same atomic module while `knowledge/index.json` remains a rebuildable consumer-owned catalog. The Bot selects selfie references from the unique catalog and `knowledge_search` searches the unique index.

## Content-Addressing Checks

Before treating content as published:

1. Resolve the fixed authoritative entry for the current Agent.
2. Require a safe relative referenced path; reject absolute paths, parent traversal, backslashes, symbolic links, and cross-Agent locations.
3. Recompute or verify the recorded SHA-256 and byte count.
4. For media, verify detected format, extension, size, and dimensions against the operation result.
5. Require the index revision or atomic manifest update to succeed.
6. Read back the authoritative entry or API result.

Never overwrite an existing digest-named file with different bytes. Never create a second manifest to bypass a conflict.
