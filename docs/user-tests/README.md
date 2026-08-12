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
- `conversation` or `dream` input;
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
  --provider-id open-arona-codex \
  --model gpt-5.6-sol \
  --lock-provider-routes \
  --confirm-copy-provider-credential
```

The destination receives `.sunabot-user-test-workspace.json`. `--agent` selects the source Agent whose `agent.json`, persona files other than `AIR.md`, recognized Agent-local prompt overrides, and recognized system prompt overrides are retained; omit it only when the source default Agent is the intended case identity. Preserved prompt and persona entries must be regular files, and a symbolic link or special file at a retained path fails preparation. The allowlist is applied during the first Agent copy, so `AIR.md`, Markdown/JSONL memory, `data/`, `runtime/`, `cache/`, `.prompt-migration-backups/`, prompt migration state, `voice/`, `files/`, `assets/`, existing extensions, and historical workbench content never enter the destination; a copy-hook failure removes the partial destination. Public prompt content is retained from its symlink-free prompt directory while hidden migration markers and backups are discarded. Preparation then performs the same allowlist as a post-copy check, creates clean managed extension indexes, leaves MCP empty, and installs `workbench-config` from the current release bundle through the production bundled-Skill installer; it never copies a production Skill as a shortcut. The current Agent workbench is created from this clean isolated root when the runtime or a case fixture first resolves it. All case-specific knowledge, media, AIR, memory, files, and other workbench resources must come from `input.fixture`.

`--lock-provider-routes` requires both `--provider-id` and a non-empty `--model`. The selected source Provider must exist and use `kind: "codex-responses"`. Preparation keeps only that Provider, makes it the default, fixes `baseUrl` to `https://chatgpt.com/backend-api/codex`, removes unsupported Agent-local Provider collections, strips inline credential fields from the shared and Agent documents, and writes the requested model into both documents for the main reply, image reader, Tone, memory, user-group orchestrator, legacy group-thread route, Codex tool, and Bash audit routes. The isolated environment contains exactly the selected Provider variable and a distinct synthetic OneBot token variable. Preparation enumerates and verifies the Provider container, fixed endpoint, environment names, absence of inline secrets, and every locked provider/model field after bundled-Skill installation; any mismatch or intermediate failure removes the destination. The marker persists the locked Provider、model and the two allowed environment names. Every later `run` repeats the same document、endpoint、environment and isolated Codex-home validation before importing Runtime or constructing a Provider, so prepare-to-run drift fails before external execution. The selected Provider's `imageModel` and unrelated tool Provider settings remain unchanged. During a locked harness run, `websearch`, `webfetch`, `generate_img`, `selfie`, and `send_voice_message` definitions remain visible to the authorized Provider, while execution is locally denied before any external runner. The Codex schema also remains visible when the runtime capability exposes its worker or control contract, but its execution is locally denied unless the workspace marker confirms an explicit Codex auth copy. Native Bash retains its production adversarial approval contract for cases that explicitly require it; the locked Bash audit model uses the selected Provider, and fixture approval must reject network commands. Provider/model arguments without `--lock-provider-routes` are rejected, while prepare without any of the three route-lock arguments retains the existing default-Provider behavior.

Cases that exercise the Codex worker or control contract may append `--copy-codex-auth`. This separate opt-in is accepted only together with a locked `codex-responses` Provider. It copies exactly the source workspace's standard `secrets/codex/auth.json` into the same isolated path; the source and destination must resolve within their respective workspace roots, every path component below the root must be a real directory, and `auth.json` must be a regular single-link JSON file with a non-empty `tokens.access_token`. The copied bytes are unchanged, the destination mode is `0600`, and the copy is revalidated after bundled-Skill installation. Preparation creates and validates the standard isolated `secrets/codex` directory for every route-locked workspace; the directory must be empty when the flag is absent. `auth.json` never enters `secrets/runtime.env`, the marker records only `codexAuthCopied: true|false`, and any copy or validation failure removes the destination. Before Runtime and the app-server control runner are constructed, every route-locked run overrides any inherited `SUNABOT_CODEX_GUI_HOME` with this isolated directory, so list/start/resume cannot enumerate the operator's real Codex task metadata. When `codexAuthCopied` is not true, both worker and control execution return a local unavailable result before dispatch; the two explicitly authorized Codex cases may proceed. A marker without a Provider route lock keeps the ordinary harness environment and execution behavior. Each Codex case must use a fresh isolated destination and its own explicit flag.

The destination config binds the selected Agent as `defaultAgentId`, preventing a sampled branch case from running under another Agent's persona. Conversation runs create the case-declared account only inside the isolated registry when the selected Agent has no account yet; they do not copy source account identities or write to the source registry. `run` rejects unmarked workspaces and binds `SUNABOT_WORKSPACE` before importing any Runtime or path module; the harness regression proves the application and queue databases are created only below that destination. Every independent run or network/permission retry prepares a fresh workspace. Reusing the same case digest fails with `USER_TEST_WORKSPACE_CASE_ALREADY_RUN`; a different case that repeats an earlier raw OneBot message fails with `USER_TEST_ONEBOT_EVENT_ALREADY_USED` instead of reusing an earlier Session or outbox. Only a case suite that explicitly requires chained state may reuse one workspace, and every step must have a different case and message ID. Public prompt overrides are copied only from a regular, symlink-free directory inside the source workspace and the destination config is rewritten to its isolated prompt directory. Branch cases replace their declared working memory, long-term memory, and user-profile collections before invoking production code. The mock transport captures outgoing messages, assets, and pokes without connecting to NapCat or sending QQ messages.

Native Bash cases use the isolated Agent's canonical Workbench directly and do not require a Colima or Docker bind mount. Linux/WSL Bubblewrap cases must run on Linux or WSL; running one on macOS is an environment preflight failure because macOS exposes host Bash only to administrator private chat and authenticated administrator Web Chat.

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

`input.fixture` makes conversation preconditions executable. It can replace declared working-memory, long-term-memory and user-profile collections, replace a valid `AIR.md`, and create bounded UTF-8 files in the isolated current Agent workbench before raw OneBot ingress. Each `workbenchFiles` item contains exactly `path` and `content`; there is no backend selector. Workbench paths are relative, traversal and symbolic-link directory components are rejected, and an existing target fails closed. Use `expected.requiredOutboundKinds` and `forbiddenOutboundKinds` to distinguish `message`, `asset`, and `poke`; total-count assertions alone are insufficient for silent and media cases.

`input.fixture.conversationMessages` seeds 1–120 declared model-visible history messages into the target conversation through the normal conversation record and persistence path before raw OneBot ingress. Message IDs must be unique, sequences must start at 1 without gaps, timestamps must increase strictly and precede the current event, and user messages must declare `userId`. The new inbound event remains the sole fresh work item.

`expected.providerPrompt` selects every round-zero `model.request` transport attempt for one exact `promptFamily`. In each attempt, every `orderedText` token must occur exactly once and in the declared order, while every optional `forbiddenText` token must be absent. Reports retain per-attempt token counts and order results without copying matched prompt bodies into assertion output.

`input.fixture.attachmentSources` provides bounded Base64 file bytes for raw OneBot attachment events. The recording transport resolves them only when the request keeps the case `accountId`; reports retain safe resolution evidence and `expected.requiredInboundAttachments` can assert the parsed name, status, format, MIME, byte count, SHA-256, page count and stable handle.

`resetKnowledge` is a boolean. When it is `true`, the driver resets the canonical Workbench knowledge directory only inside a marker-verified isolated user-test workspace and recreates an empty `knowledge/` directory before fixture files are written. Use it for chained cases whenever the current step must prove that knowledge or media came only from its own `input.fixture`.

Dream cases require logical `now`, `timePolicy: "rebase_to_runtime"`, explicit `workingMemory`, `longTerm`, `userProfiles`, `persona`, `conversations`, `activeTasks`, and nullable `directorSchedule` fields. The driver shifts event timestamps and tasks to one captured runtime clock value, remaps Director items to the target Dream date while preserving their local wall-clock times, replaces the complete memory and conversation collections, creates declared active tasks, commits the declared Director schedule, reloads the declared persona files, and calls the production Dream branch without the manual-trigger notification, so no OneBot message is created. Timeline evidence records the fixture anchor, runtime anchor, offset, Dream schedule date, and Director date without content. `timePolicy: "fixed"` is accepted only as a declarative contract for controlled-clock unit tests and a live `run` rejects it. A Dream run requires a fresh isolated task/Director/Dream-history state; arbitrary prior Dream history, recall counters, system timezone, and per-case selection configuration remain deterministic unit-test responsibilities because production exposes no safe bulk seeding API for them.

Dream runs report their success state and fail the mechanical gate when Dream does not reach `completed`. `requiredText` and `forbiddenText` inspect captured user-facing outbound text for conversation cases and generated or committed Dream output for Dream cases.

Executable branch examples:

- [`dream-minimal-memory-cycle.md`](./dream-minimal-memory-cycle.md)
- [`dream-time-preserving-compression.md`](./dream-time-preserving-compression.md)
- [`dream-smoke.md`](./dream-smoke.md)
- [`dream-scheduled-task-recovery.md`](./dream-scheduled-task-recovery.md)
- [`dream-soft-link-recovery.md`](./dream-soft-link-recovery.md)
- [`add-workmemory-direct-write.md`](./add-workmemory-direct-write.md)
- [`add-user-profile-tool.md`](./add-user-profile-tool.md)
- [`conversation-message-32-private.md`](./conversation-message-32-private.md)
- [`conversation-message-32-group.md`](./conversation-message-32-group.md)
- [`card-message-conversation-history.md`](./card-message-conversation-history.md)
- [`sampled-dream.md`](./sampled-dream.md)

Web Chat lifecycle:

- [`cases/admin-console/web-chat-deadline-cancellation.md`](./cases/admin-console/web-chat-deadline-cancellation.md)
- [`cases/admin-console/log-business-node-filtering.md`](./cases/admin-console/log-business-node-filtering.md)
- [`cases/admin-console/qq-account-automatic-transfer.md`](./cases/admin-console/qq-account-automatic-transfer.md)
- [`cases/admin-console/manual-dream-repeat.md`](./cases/admin-console/manual-dream-repeat.md)

Stateful media chains:

- [`sent-image-reuse-send.md`](./sent-image-reuse-send.md) → [`sent-image-reuse.md`](./sent-image-reuse.md)
- [`sent-emoji-reuse-send.md`](./sent-emoji-reuse-send.md) → [`sent-emoji-reuse.md`](./sent-emoji-reuse.md)
- [`orchestrator-internal-history-seed.md`](./orchestrator-internal-history-seed.md) → [`orchestrator-internal-history-reply.md`](./orchestrator-internal-history-reply.md)

Current-message media:

- [`qq-private-pdf-attachment.md`](./qq-private-pdf-attachment.md)
- [`parse-failed-attachment-export.md`](./parse-failed-attachment-export.md)
- [`current-message-image-reference.md`](./current-message-image-reference.md)
- [`external-reference-image-addresses.md`](./external-reference-image-addresses.md)
- [`current-message-image-4k-retry-budget.md`](./current-message-image-4k-retry-budget.md)
- [`generated-image-aspect-preservation.md`](./generated-image-aspect-preservation.md)
- [`cases/workbench-resources/admin-group-imports.md`](./cases/workbench-resources/admin-group-imports.md)

Tone delivery:

- [`tone-segmented-more-than-three.md`](./tone-segmented-more-than-three.md)

Workbench resources:

- [`single-workbench-resource-addressing.md`](./single-workbench-resource-addressing.md)
- [`bash-skill-repository-install.md`](./bash-skill-repository-install.md)

Native Bash agent loops:

- [`cases/bash-agent-loop/admin-private-native-download.md`](./cases/bash-agent-loop/admin-private-native-download.md)
- [`cases/bash-agent-loop/admin-group-native-archive.md`](./cases/bash-agent-loop/admin-group-native-archive.md)
- [`cases/bash-agent-loop/user-private-native-coding-repair.md`](./cases/bash-agent-loop/user-private-native-coding-repair.md)
- [`cases/bash-agent-loop/user-group-native-download.md`](./cases/bash-agent-loop/user-group-native-download.md)

Tool catalog coverage:

- [`current-system-tools.md`](./current-system-tools.md)

Historical 0.2.0 migration compatibility:

- [`user-private-attachment-docker-workbench.md`](./user-private-attachment-docker-workbench.md)

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

The sampler opens SQLite read-only with `query_only`, verifies the database, `WORKING_MEMORY.md`, and optional persona-file realpaths remain under the source workspace, then reads recent conversations, long-term memory, and user profiles. It keeps the latest 64 messages from each selected conversation by default; `--message-limit` accepts 1–256. `--include-working-memory-conversations` first selects exact conversation IDs referenced by the bounded working-memory document, then fills the remaining conversation limit with recent conversations. Internal, failed, and still-running messages are excluded from the sanitized conversation. Image, video, voice, and file placeholders plus reply message IDs are removed from free text; segment-only messages are omitted, and segment totals plus mixed-message image/quote counts remain numeric evidence only. The digest-covered `fixture.messageSelection` records bounded source, model-visible, included, segment-only, internal, failed, running, other, media, and quote counts without retaining excluded text. The output parent must already exist and resolve outside the source workspace.

The resulting V2 artifact is structured for Dream fixtures. It replaces conversation, message, memory, user, group, and name identities with typed synthetic values; string and numeric `userId`/`userIds` values retain distinct synthetic identities instead of collapsing to a shared redaction marker. It shifts structured timestamps to a fixed UTC epoch while preserving relative order, renumbers sampled message positions, and removes credentials, signed query values, host paths, opaque forwarded payloads, long identifiers, explicit aliases, free-text absolute dates, identifiable locations, and mechanically recognizable sensitive personal events. The mapping is neither stored nor reversible. Free-text review remains mandatory because pattern redaction cannot prove that every identifying phrase was removed. Production Dream identity handling does not relax this boundary: sampled user-test fixture state sent to an external Provider remains independently and irreversibly de-identified, and preparation or derivation may not reintroduce identities from production AIR, memory, conversations, or resource files. Any separately authorized selected persona and prompt disclosure remains an explicit Provider execution prerequisite and is not part of the sampled fixture. The sampler never constructs `ApplicationDataStore`, runs migrations, initializes recall tracking, or invokes Runtime against the source workspace.

After a fixture Agent reviews the V2 artifact, combine it with a prewritten sample-compatible branch case. Derivation changes only the case `input`; the template's goal, expected assertions, and quality criteria remain intact:

```bash
npm run user-test -- derive-branch-case \
  --sample /absolute/temporary/plana-memory-sample.json \
  --template /absolute/prewritten-dream-case.md \
  --output-root /absolute/temporary/derived-cases \
  --output dream-from-sample.md \
  --confirm-reviewed-sanitized-sample
```

Derivation accepts Dream templates only. It injects the reviewed working memory, long-term memory, user profiles, persona, and conversations, takes the sample's logical `now`, remaps Dream tasks and Director wall-clock schedule to the sample timeline, and lets the runtime driver remap the complete fixture to execution time. When sanitization replaces the complete AIR body with `[sensitive-content-redacted]`, derivation uses a canonical empty field-knowledge document instead of restoring or forwarding any source AIR content. A sample-compatible template must use content-independent assertions and quality criteria. The command rejects legacy V1 samples, a changed sample digest, conversation templates, unreviewed free text, symlinked inputs or output roots, input overwrite, traversal, and an existing output.

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

Each release lists every required executable harness case and its sealed reports in `.user-test-runs/release-manifest.json`. Case paths resolve relative to the manifest and must identify the exact checked-in documents required by the current release coverage contract. The manifest cannot reduce that set, substitute another document with the same case ID, add an unrelated case in place of a required case, or lower its checked-in independent-run quorum.

```json
{
  "schemaVersion": 1,
  "suiteId": "release-0.3.0",
  "sourceRevision": "CURRENT_40_CHARACTER_GIT_REVISION",
  "cases": [
    {
      "caseDocument": "../docs/user-tests/single-workbench-resource-addressing.md",
      "reports": [
        "single-workbench.sealed.json"
      ],
      "minimumIndependentRuns": 1
    },
    {
      "caseDocument": "../docs/user-tests/cases/bash-agent-loop/admin-private-native-download.md",
      "reports": [
        "native-bash-1.sealed.json",
        "native-bash-2.sealed.json"
      ],
      "minimumIndependentRuns": 2
    },
    {
      "caseDocument": "../docs/user-tests/webfetch-lightpanda-dynamic.md",
      "reports": [
        "lightpanda-webfetch-1.sealed.json",
        "lightpanda-webfetch-2.sealed.json"
      ],
      "minimumIndependentRuns": 2
    }
  ]
}
```

The v0.3.0 coverage contract is exact:

| Capability | Canonical case ID | Canonical case document | Minimum independent runs |
| --- | --- | --- | ---: |
| Canonical Workbench | `workbench-resources.single-addressing` | `docs/user-tests/single-workbench-resource-addressing.md` | 1 |
| Native Bash | `bash-agent-loop.admin-private-native-download` | `docs/user-tests/cases/bash-agent-loop/admin-private-native-download.md` | 2 |
| Lightpanda WebFetch | `webfetch.admin-private-lightpanda-dynamic` | `docs/user-tests/webfetch-lightpanda-dynamic.md` | 2 |

The Lightpanda case remains mandatory release evidence and runs in its declared Linux environment. A macOS run cannot remove it from the manifest. `offline-release-first-run.md`, `soul-package-roundtrip.md`, `native-core-single-container-boundary.md`, migration documents, CLI narratives, and cross-platform acceptance plans are deterministic or field-acceptance specifications; they do not count as executable harness cases and cannot appear in place of the three required documents. CI continues to cover their installer, CLI, Soul, runtime-contract, integration, runtime-smoke, E2E, visual and platform assertions through the dedicated deterministic lanes.

Validate it explicitly:

```bash
npm run user-test -- release-gate \
  --manifest .user-test-runs/release-manifest.json
```

The gate selects the coverage contract from the checked-in release version, requires the manifest case paths to match that complete canonical set, verifies each canonical document's expected case ID, and then revalidates every sealed review against the current case digest and Git revision. Duplicate run IDs or reviewers remain invalid, and every case must satisfy its declared quorum without dropping below the checked-in minimum. `npm run runtime:release` runs this gate before creating a release. The GitHub tag workflow may publish only after `verify` and the light/dark visual matrix pass, then invokes `runtime:release` for each target architecture; calling the artifact builder directly is not a release path, and missing current-revision evidence fails the workflow before an archive is uploaded.

### Immutable evidence tag

A source tag such as `v0.3.0` requires the annotated evidence tag `user-test-evidence-v0.3.0`. The evidence tag points to an independent root commit whose tree contains exactly one root `release-manifest.json` and the root `*.sealed.json` files referenced by that manifest. Directories, symbolic links, executable files, unreferenced reports, missing reports, and all other paths are rejected. Every file uses Git mode `100644`; report paths in the manifest are direct filenames, while case documents continue to use the required source-tree paths such as `../docs/user-tests/single-workbench-resource-addressing.md` after extraction to `.user-test-runs/`.

The manifest and every sealed report must already contain the source tag's 40-character commit in `sourceRevision`. CI never edits those files. The gate job fetches the annotated evidence tag explicitly, verifies its tree and revision binding, writes the original blob bytes with mode `0600` under `.user-test-runs/`, runs the existing release gate, and pins the evidence commit as a job output. Both architecture jobs fetch the same tag again, reject a changed commit, materialize the same bytes, and run `runtime:release`. Protect `user-test-evidence-v*` from update and deletion in the repository ruleset; creating the evidence tag does not trigger the `v*` release workflow.

Create the evidence commit without changing the source working tree or ordinary Git index. Run this only after the source commit is final, `v0.3.0` points to `HEAD`, the manifest lists direct sealed-report filenames, and the local release gate passes:

```bash
SOURCE_TAG=v0.3.0
EVIDENCE_TAG="user-test-evidence-${SOURCE_TAG}"
EVIDENCE_DIR=.user-test-runs

test "$(git rev-parse HEAD)" = "$(git rev-parse "${SOURCE_TAG}^{commit}")"
npm run user-test -- release-gate --manifest "$EVIDENCE_DIR/release-manifest.json"
git rev-parse --verify "refs/tags/$EVIDENCE_TAG" >/dev/null 2>&1 && exit 1

EVIDENCE_TMP=$(mktemp -d "${TMPDIR:-/tmp}/sunabot-evidence.XXXXXXXX")
trap 'rm -rf -- "$EVIDENCE_TMP"' EXIT
EVIDENCE_INDEX="$EVIDENCE_TMP/index"
GIT_INDEX_FILE="$EVIDENCE_INDEX" git read-tree --empty

MANIFEST_BLOB=$(git hash-object -w -- "$EVIDENCE_DIR/release-manifest.json")
GIT_INDEX_FILE="$EVIDENCE_INDEX" git update-index --add --cacheinfo \
  100644 "$MANIFEST_BLOB" release-manifest.json

REPORTS=$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const reports = [...new Set(manifest.cases.flatMap((entry) => entry.reports))].sort();
  if (!reports.length || reports.some((name) => !/^[A-Za-z0-9][A-Za-z0-9._-]*\.sealed\.json$/.test(name))) process.exit(1);
  process.stdout.write(reports.join("\n"));
' "$EVIDENCE_DIR/release-manifest.json")
for REPORT in $REPORTS; do
  REPORT_BLOB=$(git hash-object -w -- "$EVIDENCE_DIR/$REPORT")
  GIT_INDEX_FILE="$EVIDENCE_INDEX" git update-index --add --cacheinfo \
    100644 "$REPORT_BLOB" "$REPORT"
done

EVIDENCE_TREE=$(GIT_INDEX_FILE="$EVIDENCE_INDEX" git write-tree)
EVIDENCE_COMMIT=$(printf 'User-test evidence for %s\n' "$SOURCE_TAG" | git commit-tree "$EVIDENCE_TREE")
git tag -a "$EVIDENCE_TAG" "$EVIDENCE_COMMIT" -m "User-test evidence for $SOURCE_TAG"
git ls-tree "$EVIDENCE_TAG^{commit}"
git push origin "refs/tags/$EVIDENCE_TAG:refs/tags/$EVIDENCE_TAG"
```

`git commit-tree` receives no parent, and the temporary `GIT_INDEX_FILE` keeps the source index untouched. `git tag` and `git push` omit force flags, so an existing local or remote evidence tag stops the procedure instead of replacing evidence.

## Coverage boundary

Harness cases can replace high-level happy-path assertions that only check whether a real model chose a tool and produced useful content. They do not replace deterministic protocol matrices, security rejection, fault injection, SQLite recovery, migrations, concurrent/idempotent Session behavior, visual checks, cross-platform runtime contracts, or real NapCat/QQ acceptance. No existing test is removed merely because a case document exists; replacement requires a current-revision sealed pass and an explicit case-to-assertion equivalence record.

The former direct Provider non-empty ping under runtime smoke is superseded by sealed live main-conversation cases that prove OneBot → Runtime → Provider → tool loop/outbox behavior and output quality. The real NapCat connection/action smoke remains independent.
