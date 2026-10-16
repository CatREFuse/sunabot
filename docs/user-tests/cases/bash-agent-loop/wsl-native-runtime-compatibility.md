# WSL Native tool runtime compatibility

## Goal and environment

An administrator in private chat receives an archive produced by Native Bash while both NapCat accounts are running. Use Linux/WSL, a non-root Core user, an isolated harness workspace, and the configured approved Provider. The host user's existing thread count must exceed 64; production QQ processes may supply this load without creating extra load processes.

## Mechanical acceptance

Before the conversation run, exercise the production sandbox with Bash, Python and the locked Node runtime. All must execute successfully even when Node is installed outside `/usr`. Verify that the 64-thread limit is applied inside the new user namespace, file and descriptor limits remain active, and a deliberately lowered process limit still rejects a bounded fork attempt. No host HOME, credentials, or unrelated workspace is mounted. The runtime doctor and tool capability must use the same sandbox invocation and agree on a failed execution probe.

The conversation must use the raw OneBot ingress, real Provider and independent Bash audit, and mock delivery. Validate the returned archive and its exact content. Every retry uses a new isolated workspace. No production workspace data or real QQ delivery is used.

Credential preparation must support the current `secrets/codex/auth.json` when the selected token variable is absent and `OPEN_ARONA_CODEX_AUTH_FILE` is unset, empty, or whitespace. Copy only the selected access token into the isolated environment, keep the source bytes unchanged, and leave the isolated Codex home empty unless the existing separate auth-copy opt-in is supplied. An explicitly configured auth path still uses the existing source-workspace boundary and must reject an external file before Provider execution.

WSL process probes must parse only successful `ps` stdout and drain captured output through stdio close, including data received after process exit. A terminal-size warning on stderr must not become part of a process start signature or cause a healthy Core or account daemon to be reported as a reused PID. Failed process commands must retain their stderr diagnostics.

<!-- sunabot-user-test-case:v1 -->
```json
{
  "schemaVersion": 1,
  "id": "bash-agent-loop.wsl-native-runtime-compatibility",
  "title": "WSL Native runtime compatibility",
  "kind": "conversation",
  "goal": "The administrator receives a verified archive generated with Node and Python through Native Bash.",
  "input": {
    "actor": "admin_private",
    "accountId": "primary",
    "selfId": "40004",
    "replyEnabled": true,
    "fixture": {
      "workbenchFiles": [{"path": "runtime-input.txt", "content": "alpha=3\nbeta=5\n"}]
    },
    "event": {
      "post_type": "message",
      "message_type": "private",
      "message_id": 761020,
      "self_id": 40004,
      "user_id": 10001,
      "time": 1788000020,
      "sender": {"nickname": "fixture-admin"},
      "message": "读取当前工作目录的 index.md，然后用 native_bash 执行 Node 脚本，读取 runtime-input.txt 并将两项数字之和写入 runtime-result.txt，内容应为 total=8。用 Python 回读核对内容，核对成功后将输入和结果打包为 runtime-result.tar.gz，通过 send_file 发回这里。必须实际执行 Node 和 Python，回复完成状态和文件名即可。",
      "raw_message": "读取当前工作目录的 index.md，然后用 native_bash 执行 Node 脚本，读取 runtime-input.txt 并将两项数字之和写入 runtime-result.txt，内容应为 total=8。用 Python 回读核对内容，核对成功后将输入和结果打包为 runtime-result.tar.gz，通过 send_file 发回这里。必须实际执行 Node 和 Python，回复完成状态和文件名即可。"
    }
  },
  "expected": {
    "requiredTools": ["native_bash", "send_file"],
    "requiredAvailableTools": ["native_bash", "send_file"],
    "requiredOutboundKinds": ["asset"],
    "forbiddenText": ["/home/", "workspace/business", "Bearer "],
    "minimumOutboundCount": 1,
    "maximumOutboundCount": 4
  },
  "quality": {
    "criteria": [
      {"id": "execution", "description": "The trace proves Node computed the result and Python verified it in the actual sandbox.", "minimumScore": 5},
      {"id": "artifact", "description": "The delivered archive contains the source and exact total=8 result and targets the original mock conversation.", "minimumScore": 5},
      {"id": "grounding", "description": "The answer accurately describes the successful result without secrets or host paths.", "minimumScore": 5}
    ]
  }
}
```
