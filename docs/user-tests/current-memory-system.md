# Current memory-system user test plan

## Goal

Verify working-memory compression, user-profile extraction, explicit `add_workmemory`, recall, AIR updates, Dream selection/consolidation, and their influence on a later main reply. The authenticated Memory page also shows the selected Agent's exact 24-hour working-memory processing result as successful attempts over total attempts, together with the current queued-message count.

## Cases

Use synthetic fixtures and, after explicit sampling authorization, reviewed V2 sanitized samples from the running test accounts. Memory-compression cases include ordered private and group messages, existing working and long-term memory, user profiles, multiple participants, time/causal changes, and facts that must not be retained. Dream cases include recent and older working/long-term memory, user profiles, recent conversations, active tasks, planned schedule, and persona evidence. Recall statistics, prior Dream history, system timezone, and per-Agent Dream-selection configuration stay in deterministic unit tests because the production branch APIs do not expose stable per-case fixture seams for them. Main-conversation cases verify that stored memory is recalled only when relevant and that imagined Dream content is not presented as fact.

The report records prompt families reached, model output, parsed facts/actions, before/after Markdown, SQLite memory changes, operation logs, Dream stage history, CAS/rollback status, and later reply evidence. UI verification seeds explicit `working.compression_attempt` events inside and outside the 24-hour window plus a deterministic scheduler snapshot, then checks the API window boundaries, numerator, denominator and pending count before checking the rendered light/dark desktop and mobile layouts. With no attempts in the window, the rate is shown as unavailable alongside `0 / 0`; it is never inferred from unrelated memory logs.

Memory-debt alert verification seeds more than 100 pending eligible messages for one Agent and expects exactly one fixed literal administrator-private message through the durable Session/outbox path, with no Provider call, assistant conversation projection, or memory feedback. Repeated checks during the same over-limit episode produce no second alert; returning to 100 or fewer pending messages resets the persisted latch, and the next breach produces one new alert. Delivery selects an enabled account belonging to the same Agent and skips safely when the administrator or an eligible account is unavailable.

## Quality

Score factual fidelity, coverage of relevant events, time and causal consistency, useful first-person memory, correct participant identity, absence of invented facts, and isolation of imagined Dream material. Structure-only success with poor or misleading content fails.
