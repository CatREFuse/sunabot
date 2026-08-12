# Current memory-system user test plan

## Goal

Verify that every ordinary main reply completes `add_workmemory` and then `add_user_profile`, that both tools bind writes to the current Agent and current inbound speaker, and that no conversation, delivery, scheduler, or maintenance task writes working memory or user profiles in the background. Recall, AIR, and Dream remain independent memory capabilities.

## Cases

Conversation cases cover direct working-memory writes, current-speaker aggregate profile updates, explicit skip decisions, recall, AIR updates, and later replies influenced by stored factual memory. Dream cases cover recent and older working and long-term memory, user profiles, conversations, tasks, schedules, and persona evidence. The current tool cases also verify that the model cannot submit Agent IDs, conversation IDs, user IDs, timestamps, or other host-owned routing metadata.

Reports retain the two tool calls in order, their bounded results, the working-memory document revision, the current speaker's profile before and after, operation logs, outbound replies, and Dream stage history where applicable. Repository checks confirm that the deleted compression prompt, memory scheduler, queue metrics, batch processing entrypoint, and background enqueue calls are absent.

## Quality

Score factual fidelity, useful first-person working memory, stable profile quality, preserved preferred-name order, correct current-speaker binding, absence of invented facts, and isolation of imagined Dream material. A structurally valid tool call with misleading or incomplete content fails.
