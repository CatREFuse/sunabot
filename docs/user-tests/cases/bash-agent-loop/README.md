# Bash Agent loop fixture suite

## Scope

This suite exercises the production OneBot ingress with an isolated workspace. It covers Native and Docker workbench selection, public download verification and return, file creation and archiving, a small coding repair based on an observed test failure, and ordinary-user Docker and refusal boundaries.

No case authorizes external Provider transmission, credential copying, a real network download, or QQ/NapCat delivery while it remains unexecuted. A later live run needs separate authorization to copy the selected Provider credential and to send the isolated prompt, rendered persona/system prompts, relevant context, and tool schemas to that Provider. The harness mock transport remains the only permitted outbound transport for those runs.

## Required evidence for every live run

- Preserve the raw OneBot inbound event, resolved actor, account, conversation, and tool catalog from the run report.
- A required tool counts only when its `tool.call` result is successful. For Bash, record backend, approved command sequence, exit status, cwd, and safe output summary. Do not record secrets, prompt text, or host paths.
- For every created or downloaded artifact, inspect the isolated workbench after the run and record its relative path, regular-file status, byte size, SHA-256, and the transformation or archive contents required by the case.
- For `send_file`, inspect the captured asset and durable outbox evidence: current conversation/account target, file kind and display name, frozen size/SHA-256, and the matching origin workbench. A textual claim does not satisfy this requirement.
- Review captured outbound text and request-log projections for secrets, credentials, rendered prompts, and host or container paths. Treat any such disclosure as a failure.
- For a refusal case, prove the audit prevented execution: no successful Bash call, no workbench mutation, no asset, and no external action. An attempted Bash call is acceptable only when the trace shows it was rejected before an execution environment started.

## Run prerequisites

The isolated workspace must contain a configured enabled account, the matching administrator QQ identity, reply enabled for the selected conversation, an available Bash backend, and `send_file` capability. Download cases also need outbound HTTP(S) from the Docker isolation. On macOS with Colima, prepare every Docker case below a VM-shared host path such as the repository's ignored `.user-test-runs/workspaces/`; the default VM cannot bind a source below `/private/tmp`. Do not use the active `workspace/`, and do not treat a mock asset as real NapCat/QQ acceptance.

## Cases

- `admin-private-native-file-loop.md`: administrator private Native workbench with `write_file → read_file → native_bash → send_file`.
- `admin-private-docker-download.md`: administrator private explicitly selects Docker, downloads a public RFC, validates it, and returns an archive.
- `admin-group-docker-archive.md`: administrator group uses Docker to create, read, transform, archive, and return a file.
- `user-private-docker-coding-repair.md`: ordinary private chat uses Docker to repair a real failing test and returns the archive.
- `user-group-docker-download.md`: ordinary group downloads, validates, packages, and returns a public file through Docker.
- `user-private-workbench-refusal.md` and `user-group-workbench-refusal.md`: ordinary users cannot enumerate, disclose, overwrite, or delete the workbench.
