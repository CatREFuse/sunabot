# System Agent tool-flow suite

## Scope

This suite verifies Agent tool calls from raw OneBot events through the production inbound adapter, Session, Provider loop, tool executor, durable outbox, and mock delivery port. It covers the four required actors: administrator private chat, non-administrator private chat, administrator group chat, and non-administrator group chat.

All live runs require an isolated workspace, a Provider explicitly authorized to receive the rendered prompt/context/schema material, and the two harness execution gates. The mock port captures output and never connects to NapCat or sends QQ messages. Do not use the active workspace or prepare/copy a Provider credential before that authorization exists.

## Current catalog snapshot

`AGENT_TOOL_NAMES` has 25 names and exactly matches the fixed ToolRegistry catalog, including `read_air`, `export_chat_media`, and `import_chat_emoji`. The suite covers all 25 fixed names; runtime-generated MCP aliases are tracked separately:

| Tool family | Successful-call case | Denial or blocked contract |
| --- | --- | --- |
| Turn control and memory | `01-admin-private-memory-air.md`, `06-admin-private-no-reply.md` | `07-user-private-scope.md`, `09-user-group-scope.md` |
| Knowledge and web | `02-admin-private-knowledge-web.md` | Provider, network, or source fixture unavailable is `blocked` |
| Files and Bash | `03-admin-private-files-bash.md` | `07-user-private-scope.md`, `09-user-group-scope.md` |
| Media and voice | `04-admin-private-media.md`, `13-admin-private-generate-image.md`, `14-admin-private-selfie-voice-boundary.md` | Missing media handles or image Provider is `blocked`; the current missing voice profile is asserted from the effective catalog |
| Control and deferred work | `05-admin-private-controls.md`, `08-admin-group-collaboration.md` | `07-user-private-scope.md`, `09-user-group-scope.md` |
| Skills | `10-skill-activation-resource.md`, `11-skill-script-rejection.md` | Current Skill state is a preflight block; script execution remains unavailable |
| Dynamic MCP | `12-mcp-empty-catalog.md` | No current alias exists; no alias call may be fabricated |

At the latest read-only preflight, Plana, Arona, and Koharu each expose the enabled, digest-bound, approved `workbench-config` Skill. Its `references/workbench-addressing.md` resource is the positive activation/read fixture. Each Agent's MCP server index has zero servers. `run_skill_script` must remain absent, and there is no current dynamic `mcp__<server>__<tool>` alias to execute. Repeat this read-only preflight in the isolated workspace immediately before a live run because runtime state can change.

## Required evidence for every run

The fixture Agent must retain the sealed report and verify each listed call separately:

| Evidence | Pass condition |
| --- | --- |
| Ingress and actor | The raw OneBot event has the case actor, correct account/Agent routing, and `replyEnabled=true` when a reply is expected. |
| Provider | At least one `model.response` is successful and no terminal Provider or Runtime failure occurs. |
| Tool call | The request log has `category=tool.call`, the exact name, sanitized request parameters, a result, and `status=succeeded`. Deferred tools must reach a completed result; `queued`, `pending`, or `deferred` alone fails. |
| Result contract | Inspect tool-specific output: relative knowledge source/lines, web evidence policy, workbench-relative paths, Bash audit/exit status, generated asset metadata, cron revision, configuration confirmation, or protected Skill/MCP projection. |
| Outbox | Inspect the durable outbox and mock transport for correct count, target account/conversation, text/asset kind, filename, and no host path, secret, prompt text, or fabricated result. |
| Quality review | Score every JSON criterion with concrete evidence. A missing review remains `inconclusive`; any low score or failed mechanical assertion cannot be sealed `pass`. |

## Live-run order after authorization

For each case, validate first, prepare one unique temporary workspace only after credential-copy authorization, run with the Provider execution gate, review, seal, gate, then append the sealed result with the locked harness command. A preflight dependency failure is recorded as `blocked`; no report is appended until a real sealed run exists.

Dynamic MCP aliases are discovered from the ready runtime catalog immediately before each live run. If an alias is present later, create a sibling case with its exact alias in `requiredTools`, the server approval precondition, safe arguments, an expected successful `tool.call`, and a no-secret projection review. Do not alter this suite to claim an alias that the current catalog does not expose.
