# Memory-system fixture suite

This suite verifies the isolated Agent memory path through explicit main-turn tools, recall, AIR, and Dream. Synthetic fixtures and reviewed V2 sanitized Dream samples remain supported. Sampling a real workspace and transmitting case data to an external Provider remain separate authorization boundaries.

## Execution order

Run cases 03 through 07 in one fresh isolated workspace in numeric order. Case 03 establishes explicit working memory, case 04 proves its retrieval, case 05 records scoped AIR, case 06 consolidates the same-day record and its imagined Dream material, and case 07 checks the later reply remains grounded in factual memory. Run cases 08 and 09 independently in fresh isolated workspaces. Run `add-user-profile-tool.md` independently to verify the current-speaker aggregate profile decision.

Each live run requires a separate authorization to send its case prompt, rendered persona and system prompts, relevant memory/context, and tool schemas to the selected external Provider. Credential copying is separately gated. No case permits a real QQ or NapCat send.

## Required evidence

For every run, preserve the harness JSON report, its case digest, source revision, request-log entries, successful `tool.call` entries, session/outbox record, and the quality review. For tool writes, compare the complete before/after `WORKING_MEMORY.md` revision or current-speaker SQLite profile row and the memory operation history. For Dream, retain selection, each stage/history item, Dream archive/CAS outcome, working-memory before/after revision, and any rollback evidence.

## Authorization boundaries

Read-only real-workspace sampling, Provider credential copying, and Provider data transmission are separate explicit authorizations. Do not run `sample`, prepare a credential-bearing workspace, set `SUNABOT_USER_TEST_ALLOW_PROVIDER`, pass `--execute-provider`, or use a configured Provider unless the current task authorizes the corresponding action. A Provider authorization never permits QQ/NapCat delivery.

The executable Dream schema seeds working memory, long-term memory, user profiles, persona files, conversations, active tasks, and the Director schedule before invoking the production Dream entrypoint. Every live Dream case declares logical `now` and `timePolicy: "rebase_to_runtime"` so sampled timestamps shift as one timeline to the execution clock.

After authorization, use one temporary workspace per independent run, seal each run with an independent quality review, and append only sealed summaries to `docs/user-tests/reports/2026-07-26-system-user-test.md` through `npm run user-test -- append`.
