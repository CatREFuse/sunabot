# Memory-system fixture suite

This suite verifies the isolated Agent memory path in seven ordered cases. Cases can use synthetic fixtures or a reviewed V2 sanitized sample derived read-only from a running test account. Sampling a real workspace and transmitting any case data to an external Provider remain separate authorization boundaries.

## Execution order

Run cases 01 and 02 in fresh isolated workspaces to keep private and group evidence independent. Run cases 03 through 07 in one fresh isolated workspace in numeric order. Case 03 establishes explicit working memory, case 04 proves its retrieval, case 05 records scoped AIR, case 06 consolidates the same-day record and its imagined Dream material, and case 07 checks the later reply remains grounded in factual memory.

Each live run requires a separate authorization to send its case prompt, rendered persona and system prompts, relevant memory/context, and tool schemas to the selected external Provider. Credential copying is separately gated. No case permits a real QQ or NapCat send.

## Required evidence

For every run, preserve the harness JSON report, its case digest, source revision, request-log entries, successful `tool.call` entries, session/outbox record, and the quality review. For compression, compare the complete before/after `WORKING_MEMORY.md` content and revision, the linked SQLite user-profile rows, and memory operation history. For Dream, retain selection, each stage/history item, Dream archive/CAS outcome, working-memory before/after revision, and any rollback evidence. A reviewer scores factual fidelity, temporal and causal consistency, participant identity, usefulness, absence of invention, and imagined-material isolation at the threshold declared in the case.

## Authorization boundaries

Read-only real-workspace sampling, Provider credential copying, and Provider data transmission are separate explicit authorizations. Do not run `sample`, prepare a credential-bearing workspace, set `SUNABOT_USER_TEST_ALLOW_PROVIDER`, pass `--execute-provider`, or use a configured Provider unless the current task authorizes the corresponding action. A Provider authorization never permits QQ/NapCat delivery.

The executable branch schema declaratively seeds working memory, long-term memory, user profiles, persona files, Dream conversations, active tasks, and the Director schedule before invoking the production memory-compression or Dream entrypoint. Every live branch case declares logical `now` and `timePolicy: "rebase_to_runtime"` so sampled 2024 timestamps are shifted as one timeline to the execution clock; Director items retain their local wall-clock time on the target Dream date. Recall statistics, prior Dream history, system timezone, and per-Agent Dream-selection configuration remain deterministic unit-test coverage because the production branch APIs do not expose stable per-case fixture seams for them. Prompt-family, timeline, operation-log, SQLite, CAS, and rollback observations remain post-run evidence requirements.

After authorization, use one temporary workspace per independent run, seal each run with an independent quality review, and append only sealed summaries to `docs/user-tests/reports/2026-07-26-system-user-test.md` through `npm run user-test -- append`.
