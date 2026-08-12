---
name: create-new-bot
description: Create, import, audit, and verify a Sunabot Bot role through the supported Agent management flow. Use when Codex is asked to add a new character or Bot, clone only the safe configuration shape of an existing role such as Arona, determine which Agent data must be initialized, prepare an import package, attach optional avatar or persona files, or check whether a newly created Agent is complete without copying conversations, memory, credentials, QQ login state, or runtime artifacts.
---

# Create New Bot

Create a clean Sunabot Agent through the management API or authenticated admin console. Treat an existing role as a completeness reference, never as a directory-copy source.

## Required Reading

1. Read `docs/specs/index.md`.
2. Read the current Agent, management, persistence, code-map, and validation modules selected by that index.
3. Read [references/initialization-data.md](references/initialization-data.md) before deciding what to create, import, or leave empty.
4. Re-read the current implementations named in the reference when source and reference disagree. Current source is authoritative.

## Scope Gate

Separate these permissions:

- Creating the local Agent record and workspace.
- Importing an avatar, persona, selfie references, or system-prompt overrides.
- Creating a QQ account runtime and starting NapCat.
- Logging a QQ account in.
- Configuring voice, credentials, Skills, MCP, knowledge, emoji, or other resources.
- Calling an external Provider or sending a real QQ message.

An instruction to create a Bot authorizes only the requested local Agent and supplied role material. Require the same request to explicitly include any external account, credential, Provider, or real-message operation before performing it.

Never print, copy, package, or diff complete live `agent.json`, config, environment, database, session, or account files. Redact key-like values even when they appear in an Agent manifest.

## Workflow

### 1. Establish the target

Collect or infer only when unambiguous:

- immutable Agent ID matching `^[a-z][a-z0-9-]{1,31}$`;
- display name of 1–40 characters;
- role brief and source material for the eight persona files;
- optional avatar and selfie references with confirmed intended use;
- whether Agent-specific system prompts are required;
- which post-creation capabilities the user actually wants.

Ask for a missing identity or role choice when guessing would materially change the character. Do not invent credentials, QQ numbers, relationships, memories, voice provenance, or source permissions.

### 2. Preflight without mutation

Use the project's Node.js 24 runtime. If `node` is absent from `PATH`, use the workspace dependency runtime or the known absolute Node executable for the current host. Run:

```bash
git status --short
./sunabot.sh status
node .codex/skills/create-new-bot/scripts/audit-bot.mjs \
  --workspace ./workspace \
  --agent arona
```

Confirm the target ID is absent from `GET /api/agents` and from `workspace/business/agents/<agentId>/`. Preserve unrelated worktree changes. Do not start, restart, deploy, commit, or push merely to inspect the target.

### 3. Prepare a clean import package

Use a private temporary directory created with `mktemp -d`. Author only supported import files:

- `AGENTS.md`
- `SOUL.md`
- `PREFERENCE.md`
- `DIALOGUE_STYLE_EXAMPLES.md`
- `USER.md`
- `RELATION.md`
- `AIR.md`
- `DIRECTOR_SEED.md`
- `selfie_prompt_rewrite.json`
- optional `agent.json` containing only known non-secret Bot and OneBot settings
- optional `assets/avatar.png|jpg|webp`
- optional `selfie/references.jsonl` and matching selfie images
- optional `system-prompts/<known-file>.json`

Leave live memory, databases, account data, voice, emoji, Skills, MCP, knowledge, caches, backups, workbench outputs, and migration markers out of the package. Prefer omitting `agent.json` unless the user requested non-default per-Agent behavior; creation already derives a safe manifest from shared configuration.

Preview the package through `POST /api/agent-imports/preview`. Review every included and missing component. Missing optional components are acceptable when intentionally left clean.

### 4. Create through the supported boundary

Use the authenticated admin console or `POST /api/agents` with the exact ID, name, and optional avatar/import payload. API writes require the existing administrator session, CSRF token, and allowed Origin. Do not read credential files, persist browser cookies, or bypass the route by editing SQLite or moving files into the live Agent directory.

Creation must succeed as one flow:

1. Materialize the initial workspace in a temporary sibling directory.
2. Atomically publish the Agent directory.
3. Insert the shared registry row.
4. Install, review, and enable the bundled `workbench-config` Skill.
5. Initialize the Agent runtime and its isolated SQLite databases.

If the post-create runtime hook fails, verify that the route rolled the registry row and Agent directory back. Do not repair a half-created Bot by hand.

### 5. Apply explicitly requested follow-up data

Use the management API or admin console for each capability:

- edit persona or Agent settings and read them back;
- enable Agent-specific system-prompt overrides only when required;
- upload voice references and configure voice through the voice profile API;
- publish selfie, emoji, Skill, MCP, or knowledge resources through their fixed management entry;
- create a QQ account with `POST /api/agents/<agentId>/accounts` only when requested;
- start or log in the QQ runtime only when requested.

Never reuse Arona's QQ account, voice file, memories, databases, workbench, resource indexes, approval records, or login state as defaults for another character.

### 6. Verify in layers

Run:

```bash
node .codex/skills/create-new-bot/scripts/audit-bot.mjs \
  --workspace ./workspace \
  --agent <agentId>
```

Then verify separately:

- registry and manifest identity;
- required initial files and fixed resource entries;
- bundled Skill state and runtime database presence;
- active shared or Agent-specific prompt source;
- requested optional resources;
- QQ runtime state, when created;
- real Provider/QQ behavior, only when authorized.

Report source wiring, runtime readiness, QQ connectivity, and real message acceptance as separate results. Do not call `connected=unknown`, a populated directory, or an empty SQLite schema a live acceptance pass.

## Troubleshooting From Real Runs

### Checkout status cannot prove the serving runtime

`./sunabot.sh status` can return `DEPENDENCIES_MISSING` in the current checkout while an existing Core still serves `127.0.0.1:8787`. Treat these as separate facts. Do not run bootstrap, restart, or dependency installation merely to continue Agent creation.

Resolve the actual listener and its working directory:

```bash
lsof -nP -iTCP:8787 -sTCP:LISTEN
lsof -a -p <pid> -d cwd -Fn
```

Continue only when the listener belongs to the intended Sunabot workspace. Report the checkout status failure separately from the confirmed serving process.

### The available browser has no administrator session

When the management page shows the administrator login dialog, stop before preview, upload, or create. Hand the exact local management page to the user for sign-in, then resume with the same browser session and repeat the target-absence check. Never inspect password managers, cookies, local storage, session files, or credential files.

If the preferred browser connection is unavailable, keep the working in-app management tab for user handoff. Do not bypass authentication with direct SQLite writes or guessed credentials.

### A public role image download follows an unavailable local proxy

An explicitly approved public avatar or reference image can fail because `curl` inherits a dead loopback proxy such as `127.0.0.1:<port>`. Retry only the same approved URL with proxy bypass:

```bash
curl --noproxy '*' -L '<approved-public-url>' -o '<private-temp-file>'
file '<private-temp-file>'
shasum -a 256 '<private-temp-file>'
```

Inspect the downloaded image before import. Keep it in the private temporary package, record its source for the completion report, and never reuse the workaround for private or credentialed URLs.

### Import preview reports intentionally omitted components

A clean role package commonly reports `Agent 配置` and `系统提示词覆盖` as missing. This is expected when `agent.json` is omitted so creation can derive current safe defaults and when the role should continue using shared system prompts.

Accept these missing entries only after confirming that all eight persona files and every explicitly requested avatar, selfie reference, or final prompt are listed under included components. Reject any unexpected file or any missing requested component.

### A role image is both avatar and selfie identity reference

When the user explicitly requests the same approved original image for identity preservation, package separate copies as `assets/avatar.png|jpg|webp` and `selfie/<file>`. Compute the selfie file SHA-256 and use the exact digest as the `id` in `selfie/references.jsonl`. Preview the package and let the supported creation flow normalize and verify the selfie catalog; do not hand-edit the live catalog after creation.

### Requested original dialogue was replaced with invented examples

A role brief that explicitly asks for original dialogue requires a source ledger before creation. Do not substitute model-written dialogue examples merely because they match the researched personality.

For every quoted line, record:

- the exact original text and punctuation;
- a stable official or publisher-authorized URL;
- the source type, such as official character page, official Q&A, publisher store localization, official animation news, or a cast interview that explicitly identifies the line;
- whether the text is original Japanese, an official localization, or an attributed performance variant.

Remove every unattributed or model-written dialogue from `DIALOGUE_STYLE_EXAMPLES.md` when the user requests original lines only. Do not translate Japanese lines yourself; prefer an official localization when one exists. If no public official transcript exists, leave that portion empty and report the gap instead of transcribing from memory, inferring from a trailer, or fabricating a plausible line.

After saving sourced dialogue through the management API or admin console, read the live file back and compare its SHA-256 with the reviewed import file. Also search the live text for every corrected or rejected variant encountered during research. A successful save receipt is insufficient when the stored wording differs from the approved source ledger; correct the live file through the same supported management boundary and repeat the readback.

Check the rights holder's current usage guidelines before downloading audio, video, a full scenario, or a subtitle corpus. A public player does not by itself authorize copying or importing its media. Keep only limited sourced text excerpts permitted for the task. For a larger corpus, require user-provided material that the user is authorized to process.

## Completion

Return:

- created Agent ID and name;
- creation path used;
- initialized data by category;
- intentionally empty or inherited data;
- requested follow-up resources completed;
- audit result and remaining live acceptance gaps.

Do not include secrets, raw account identifiers, complete manifests, or copied role memory in the report.
