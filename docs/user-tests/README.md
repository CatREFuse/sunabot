# User test harness

User test harness sits between deterministic tests and the remaining release checks. It runs the current Runtime against an isolated workspace, sends raw OneBot events through the production inbound adapter, captures Session/Provider/tool/outbox evidence, and requires a separate fixture Agent to review output quality.

## Required order

For every feature:

1. Write the feature's user test case document before implementation.
2. Run the affected unit tests.
3. Run one or more user test cases with fixture Agents.
4. If every mechanical assertion and quality criterion passes, run the remaining integration, safety, migration, runtime, build, E2E, visual, and platform-specific checks.
5. Any failure returns to the primary Agent for diagnosis and repair. The fixture Agent reports evidence only.

`npm test` keeps the repository automation in the same broad order: unit tests, harness self-tests, then integration and independent safety/migration lanes. Feature-specific live user tests are explicit because they consume a Provider and require an Agent quality review. `runtime:release` additionally requires `.user-test-runs/release-manifest.json`; a release cannot be built from omitted, stale, failed, blocked, inconclusive, or unreviewed case evidence.

## Case document

Copy [`template.md`](./template.md). A case is a Markdown document containing one `sunabot-user-test-case:v1` marker followed by one JSON fence. The executable definition includes:

- one concrete user outcome;
- `conversation`, `memory_compression`, or `dream` input;
- for conversation cases, one required actor: `admin_private`, `user_private`, `admin_group`, or `user_group`;
- required and forbidden tools, text, and outbound counts;
- 1–5 quality criteria with minimum scores.

Validate it before implementation:

```bash
npm run user-test -- validate --case docs/user-tests/my-feature.md
```

## Isolated workspace

Live harness runs never use the active `workspace/`. Prepare a disposable destination. Only the selected Provider credential and selected Agent files are copied, and the credential copy requires an explicit flag:

```bash
npm run user-test -- prepare \
  --source /absolute/source/workspace \
  --destination /absolute/repository/.user-test-runs/workspaces/case-id \
  --agent koharu \
  --confirm-copy-provider-credential
```

The destination receives `.sunabot-user-test-workspace.json`. `--agent` selects the source Agent whose persona, Agent-local prompt overrides, and resource files are copied; omit it only when the source default Agent is the intended case identity. The destination config binds that Agent as `defaultAgentId`, preventing a sampled branch case from running under another Agent's persona. Conversation runs create the case-declared account only inside the isolated registry when the selected Agent has no account yet; they do not copy source account identities or write to the source registry. `run` rejects unmarked workspaces and binds `SUNABOT_WORKSPACE` before importing any Runtime or path module; the harness regression proves the application and queue databases are created only below that destination. Every independent run or network/permission retry prepares a fresh workspace. Reusing the same case digest fails with `USER_TEST_WORKSPACE_CASE_ALREADY_RUN`; a different case that repeats an earlier raw OneBot message fails with `USER_TEST_ONEBOT_EVENT_ALREADY_USED` instead of reusing an earlier Session or outbox. Only a case suite that explicitly requires chained state may reuse one workspace, and every step must have a different case and message ID. Public prompt overrides are copied only from a regular, symlink-free directory inside the source workspace and the destination config is rewritten to its isolated prompt directory. Preparation removes copied `WORKING_MEMORY.md`, `WORKING_MEMORY.jsonl`, `LONG_TERM_MEMORY.jsonl`, `USER_PROFILE.jsonl`, and the copied Agent-local `data/` directory, so a live account's raw memory, conversations, queue, or logs cannot enter a case implicitly. Branch cases replace their declared working memory, long-term memory, and user-profile collections before invoking production code. The mock transport captures outgoing messages, assets, and pokes without connecting to NapCat or sending QQ messages.

On macOS with Colima, a case that requires `docker_bash` must place its isolated destination on a host path shared with the Colima VM, such as this repository's ignored `.user-test-runs/workspaces/` directory under `/Users/...`. A destination below `/private/tmp` is valid for non-Docker cases but cannot be bind-mounted by the default Colima VM and must be recorded as an environment preflight failure rather than a product failure.

A live run sends the case prompt together with the Runtime-rendered persona, system prompts, relevant memory/context, and tool schemas to the configured external Provider. Use only a Provider authorized to receive that material. Credential copying and Provider execution are separate explicit gates; neither gate authorizes a real QQ/NapCat send.

## Run

```bash
export SUNABOT_USER_TEST_ALLOW_PROVIDER=1
npm run user-test -- run \
  --workspace /absolute/temporary/user-test-workspace \
  --case docs/user-tests/my-feature.md \
  --output .user-test-runs/my-feature.run.json \
  --execute-provider
```

Conversation cases pass a raw OneBot event through the same parser, forward-message hydration, account-to-Agent delegate, Runtime, Session queue, Provider tool loop, and durable outbox used by the WebSocket path. The declared `actor` controls an in-memory authority projection for that run: admin actors use the event user as administrator, while user actors use a distinct synthetic administrator. This makes cases portable across test accounts without persisting an administrator change. `replyEnabled` is a fixture precondition for an existing enabled conversation. A user-group fixture keeps the production ambient orchestrator path but gives its isolated conversation a 1-second response-window override; completion waits for both ambient orchestration and Session events, so the harness cannot report an empty success while the group timer is still pending.

`input.fixture` makes conversation preconditions executable. It can replace declared working-memory, long-term-memory and user-profile collections, replace a valid `AIR.md`, and create bounded UTF-8 files in the isolated Native or Docker workbench before raw OneBot ingress. Workbench paths are relative, traversal and symbolic-link directory components are rejected, and an existing target fails closed. Use `expected.requiredOutboundKinds` and `forbiddenOutboundKinds` to distinguish `message`, `asset`, and `poke`; total-count assertions alone are insufficient for silent and media cases.

`input.fixture.attachmentSources` provides bounded Base64 file bytes for raw OneBot attachment events. The recording transport resolves them only when the request keeps the case `accountId`; reports retain safe resolution evidence and `expected.requiredInboundAttachments` can assert the parsed name, status, format, MIME, byte count, SHA-256, page count and stable handle.

`resetKnowledge` may list `native`, `docker`, or both. Before fixture files are written, the driver removes copied source knowledge only inside a marker-verified isolated user-test workspace and recreates an empty `knowledge/` directory; duplicate or unknown backends are rejected. Use it whenever a case must prove that knowledge or media came only from `input.fixture`.

Memory compression cases require a logical `now` plus `timePolicy: "rebase_to_runtime"`, replace the isolated working-memory document plus the complete declared `longTerm` and `userProfiles` collections, reload the isolated persona, then call the production `processMemoryClaim` pipeline with mock messages. Before seeding, every structured timestamp is shifted by the same offset from logical `now` to one captured runtime clock value, preserving event order and relative age. Reports include the non-content timeline evidence, working-memory diff, and user-profile before/after evidence.

Dream cases require logical `now`, `timePolicy: "rebase_to_runtime"`, explicit `workingMemory`, `longTerm`, `userProfiles`, `persona`, `conversations`, `activeTasks`, and nullable `directorSchedule` fields. The driver shifts event timestamps and tasks to one captured runtime clock value, remaps Director items to the target Dream date while preserving their local wall-clock times, replaces the complete memory and conversation collections, creates declared active tasks, commits the declared Director schedule, reloads the declared persona files, and calls the production Dream branch without the manual-trigger notification, so no OneBot message is created. Timeline evidence records the fixture anchor, runtime anchor, offset, Dream schedule date, and Director date without content. `timePolicy: "fixed"` is accepted only as a declarative contract for controlled-clock unit tests and a live `run` rejects it. A Dream run requires a fresh isolated task/Director/Dream-history state; arbitrary prior Dream history, recall counters, system timezone, and per-case selection configuration remain deterministic unit-test responsibilities because production exposes no safe bulk seeding API for them.

Both branches report their success state and fail the mechanical gate when compression returns `false` or Dream does not reach `completed`. `requiredText` and `forbiddenText` inspect captured user-facing outbound text for conversation cases, committed working-memory text for compression, and generated/committed Dream output for Dream cases.

Executable branch examples:

- [`memory-compression-smoke.md`](./memory-compression-smoke.md)
- [`dream-smoke.md`](./dream-smoke.md)
- [`add-workmemory-direct-write.md`](./add-workmemory-direct-write.md)
- [`sampled-memory-compression.md`](./sampled-memory-compression.md)
- [`sampled-dream.md`](./sampled-dream.md)

Stateful media chains:

- [`sent-image-reuse-send.md`](./sent-image-reuse-send.md) → [`sent-image-reuse.md`](./sent-image-reuse.md)
- [`sent-emoji-reuse-send.md`](./sent-emoji-reuse-send.md) → [`sent-emoji-reuse.md`](./sent-emoji-reuse.md)
- [`orchestrator-internal-history-seed.md`](./orchestrator-internal-history-seed.md) → [`orchestrator-internal-history-reply.md`](./orchestrator-internal-history-reply.md)

Current-message media:

- [`qq-private-pdf-attachment.md`](./qq-private-pdf-attachment.md)
- [`parse-failed-attachment-export.md`](./parse-failed-attachment-export.md)
- [`user-private-attachment-docker-workbench.md`](./user-private-attachment-docker-workbench.md)
- [`current-message-image-reference.md`](./current-message-image-reference.md)
- [`current-message-image-4k-retry-budget.md`](./current-message-image-4k-retry-budget.md)
- [`cases/workbench-resources/admin-group-imports.md`](./cases/workbench-resources/admin-group-imports.md)

Workbench resources:

- [`dual-workbench-resource-addressing.md`](./dual-workbench-resource-addressing.md)

Codex artifacts:

- [`codex-chat-artifact-roundtrip.md`](./codex-chat-artifact-roundtrip.md)

Selfie delivery:

- [`selfie-direct-delivery.md`](./selfie-direct-delivery.md)
- [`selfie-knowledge-reference-direct-delivery.md`](./selfie-knowledge-reference-direct-delivery.md)

Group conversation reasoning:

- [`group-topic-internal-reasoning.md`](./group-topic-internal-reasoning.md)

## Read-only test-account sampling

Branch cases may sample the active test accounts:

```bash
npm run user-test -- sample \
  --source /absolute/source/workspace \
  --agent plana \
  --include-working-memory-conversations \
  --message-limit 64 \
  --output /absolute/temporary/plana-memory-sample.json
```

The sampler opens SQLite read-only with `query_only`, verifies the database, `WORKING_MEMORY.md`, and optional persona-file realpaths remain under the source workspace, then reads recent conversations, long-term memory, and user profiles. It keeps the latest 64 messages from each selected conversation by default; `--message-limit` accepts 1–256. `--include-working-memory-conversations` first selects exact conversation IDs referenced by the bounded working-memory document, then fills the remaining conversation limit with recent conversations. Internal, failed, and still-running messages that the production memory scheduler excludes are also excluded from the sanitized conversation. Image, video, voice, and file placeholders plus reply message IDs are removed from free text; segment-only messages are omitted, and segment totals plus mixed-message image/quote counts remain numeric evidence only. The digest-covered `fixture.messageSelection` records bounded source, production-eligible, included, segment-only, internal, failed, running, other, media, and quote counts without retaining excluded text. The output parent must already exist and resolve outside the source workspace.

The resulting V2 artifact is structured for branch fixtures. It replaces conversation, message, memory, user, group, and name identities with typed synthetic values; string and numeric `userId`/`userIds` values retain distinct synthetic identities instead of collapsing to a shared redaction marker. It shifts structured timestamps to a fixed UTC epoch while preserving relative order; renumbers sampled message positions; clears source compression cursors; and removes credentials, signed query values, host paths, opaque forwarded payloads, long identifiers, explicit aliases, free-text absolute dates, identifiable locations, and mechanically recognizable sensitive personal events. Identity projection is applied once through protected placeholders, so later date, time, location, and credential rules cannot rewrite synthetic identifiers; short ambiguous names require an identity boundary, and location redaction does not treat every Chinese phrase ending in an administrative or road suffix as a location. The mapping is neither stored nor reversible. Free-text review remains mandatory because pattern redaction cannot prove that every identifying phrase was removed. The sampler never constructs `ApplicationDataStore`, runs migrations, initializes recall tracking, or invokes Runtime against the source workspace.

After a fixture Agent reviews the V2 artifact, combine it with a prewritten sample-compatible branch case. Derivation changes only the case `input`; the template's goal, expected assertions, and quality criteria remain intact:

```bash
npm run user-test -- derive-branch-case \
  --sample /absolute/temporary/plana-memory-sample.json \
  --template /absolute/prewritten-dream-case.md \
  --output-root /absolute/temporary/derived-cases \
  --output dream-from-sample.md \
  --confirm-reviewed-sanitized-sample
```

For memory compression, optionally select one sanitized conversation with `--conversation conversation-0001`. Derivation injects only working-memory items whose conversation provenance matches that selected conversation, while retaining the sampled long-term memory and user profiles as surrounding context; unrelated working-memory scopes cannot be rebound by the tested batch. Media and quote counts are preserved, but their unavailable content is never treated as evidence. A sample-compatible template must use content-independent mechanical assertions and quality criteria that ask the reviewer to compare output with the injected sample; do not derive a sampled case from a synthetic scenario whose required text, participant names, dates, or quality wording describe its replaced input. Both derived branch kinds take the sample's logical `now`; Dream task times and Director wall-clock schedule are first remapped from the template timeline to the sample timeline, then the runtime driver remaps the complete fixture to execution time. The command rejects legacy V1 samples, a changed sample digest, conversation templates, unreviewed free text, symlinked inputs/output roots, input overwrite, traversal, and an existing output. The same sample, template, selector, and case schema produce byte-identical case documents.

## Quality review and gate

The run report remains `inconclusive` after mechanical execution. A fixture Agent reads the case goal, sanitized input, outbound result, tool trace, branch diff, and request logs, then writes a review JSON bound to `runId` and `caseId`. Every criterion needs a 1–5 score and concrete evidence.

```bash
npm run user-test -- seal \
  --run .user-test-runs/my-feature.run.json \
  --review .user-test-runs/my-feature.review.json \
  --output .user-test-runs/my-feature.sealed.json

npm run user-test -- gate \
  --report .user-test-runs/my-feature.sealed.json
```

The seal command requires a named reviewer, valid review time, non-empty summary, every declared criterion, and concrete evidence. It writes a private `0600` artifact and rejects a `pass` verdict if a mechanical assertion failed or any quality score is below its case threshold. A required tool passes only when at least one corresponding `tool.call` result succeeded; failed or merely queued calls do not satisfy it, and dynamic MCP aliases are retained in the trace. `forbiddenTools` rejects any matching call, while `forbiddenSuccessfulTools` permits a recorded audit rejection but proves that no matching call succeeded. `requiredAvailableTools` and `forbiddenAvailableTools` assert the effective tool catalog sent in the Provider request, so a configured capability absence is tested explicitly rather than misreported as an omitted tool call. `blocked` means a required Provider, tool, runtime, or dependency was unavailable and does not count as a pass.

Multiple fixture Agents should run independent cases in parallel. A core or complex single case may be repeated by multiple fixture Agents. They append sealed summaries to one Markdown report through the locked append command:

```bash
npm run user-test -- append \
  --report .user-test-runs/my-feature.sealed.json \
  --target docs/user-tests/reports/2026-07-26-system-user-test.md \
  --suite "Tool flow"
```

Fixture Agents do not patch product code. The primary Agent compares reports, reproduces failures, finds causes, applies scoped repairs, and starts the required cases again.

## Release manifest gate

Each release lists every required case and its sealed reports in `.user-test-runs/release-manifest.json`. Paths are resolved relative to the manifest. Use `minimumIndependentRuns: 1` for a normal case and a higher value for a core or complex case that needs independent runs and reviewers.

```json
{
  "schemaVersion": 1,
  "suiteId": "release-0.1.4",
  "sourceRevision": "CURRENT_40_CHARACTER_GIT_REVISION",
  "cases": [
    {
      "caseDocument": "../docs/user-tests/my-feature.md",
      "reports": [
        "my-feature.sealed.json"
      ],
      "minimumIndependentRuns": 1
    }
  ]
}
```

Validate it explicitly:

```bash
npm run user-test -- release-gate \
  --manifest .user-test-runs/release-manifest.json
```

The gate revalidates every sealed review, requires the current case digest and Git revision, rejects duplicate run IDs or reviewers, and enforces the declared independent-run quorum. `npm run runtime:release` runs this gate before creating a release.

## Coverage boundary

Harness cases can replace high-level happy-path assertions that only check whether a real model chose a tool and produced useful content. They do not replace deterministic protocol matrices, security rejection, fault injection, SQLite recovery, migrations, concurrent/idempotent Session behavior, visual checks, cross-platform runtime contracts, or real NapCat/QQ acceptance. No existing test is removed merely because a case document exists; replacement requires a current-revision sealed pass and an explicit case-to-assertion equivalence record.

The former direct Provider non-empty ping under runtime smoke is superseded by sealed live main-conversation cases that prove OneBot → Runtime → Provider → tool loop/outbox behavior and output quality. The real NapCat connection/action smoke remains independent.
