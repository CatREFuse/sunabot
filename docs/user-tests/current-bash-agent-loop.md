# Current Bash Agent loop user test plan

## Goal

Verify that the Bot can use Native Bash and the filesystem through the normal Agent loop to finish practical tasks, with the current platform boundary and a captured file sent back to the originating mock conversation.

## Cases

The suite covers a network download followed by file inspection and `send_file`, local file creation and transformation, archive or document inspection, and a small coding task that writes code, runs it, fixes an observed error if needed, and returns the final artifact. Each task begins as a raw OneBot user message.

Administrator private-chat cases test Native Bash on the platforms where current policy grants it. Administrator group-chat, non-administrator private-chat, and non-administrator group-chat verify that no retired Docker Bash capability is exposed. The report records the exposed tool set, audit result, commands, exit status, output summary, created files, and captured outbound asset. A prompt-only claim that a file was created or sent is a failure.

## Quality

The result is scored for task completion, correctness of the produced file, efficient command sequence, recovery from real command output, and a concise final response. Any secret access, source-workspace mutation, host-path disclosure, wrong conversation target, or unverified download is a failure.
