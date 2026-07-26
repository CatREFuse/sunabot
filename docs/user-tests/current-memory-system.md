# Current memory-system user test plan

## Goal

Verify working-memory compression, user-profile extraction, explicit `add_workmemory`, recall, AIR updates, Dream selection/consolidation, and their influence on a later main reply.

## Cases

Use synthetic fixtures and, after explicit sampling authorization, reviewed V2 sanitized samples from the running test accounts. Memory-compression cases include ordered private and group messages, existing working and long-term memory, user profiles, multiple participants, time/causal changes, and facts that must not be retained. Dream cases include recent and older working/long-term memory, user profiles, recent conversations, active tasks, planned schedule, and persona evidence. Recall statistics, prior Dream history, system timezone, and per-Agent Dream-selection configuration stay in deterministic unit tests because the production branch APIs do not expose stable per-case fixture seams for them. Main-conversation cases verify that stored memory is recalled only when relevant and that imagined Dream content is not presented as fact.

The report records prompt families reached, model output, parsed facts/actions, before/after Markdown, SQLite memory changes, operation logs, Dream stage history, CAS/rollback status, and later reply evidence.

## Quality

Score factual fidelity, coverage of relevant events, time and causal consistency, useful first-person memory, correct participant identity, absence of invented facts, and isolation of imagined Dream material. Structure-only success with poor or misleading content fails.
