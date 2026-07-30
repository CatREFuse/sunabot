// @vitest-environment node
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_TOOL_NAME,
  CODEX_MAX_JSONL_LINE_BYTES,
  CODEX_MAX_STDOUT_BYTES,
  CodexAppServerRunner,
  CodexJsonlLifecycleParser,
  CodexProcessSupervisor,
  CodexProtocolError,
  CodexToolRunner,
  cleanupPersistedCodexProcess,
  codexProcessInspectionArguments,
  codexTool,
  prepareCodexRun,
  type CodexSpawn,
  type CodexSupervisorRequest
} from "../../adapters/codex/codexTool.js";

let temporaryRoot = "";

afterEach(async () => {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = "";
  vi.restoreAllMocks();
});

describe("codex tool contract", () => {
  it("publishes the async Codex tool for complex work and directs ordinary searches to websearch", () => {
    expect(CODEX_TOOL_NAME).toBe("codex");
    expect(codexTool.name).toBe("codex");
    expect(codexTool.description).toContain("complex local workspace");
    expect(codexTool.description).toContain("modify files");
    expect(codexTool.description).toContain("administrator-triggered");
    expect(codexTool.description).toContain("deep multi-source research");
    expect(codexTool.description).toContain("long-form analysis");
    expect(codexTool.description).toContain("Use websearch for ordinary web lookups");
    expect(codexTool.parameters.required).toEqual(["task", "kind", "inputHandles"]);
    expect(codexTool.parameters.properties.inputHandles.type).toEqual(["array", "null"]);
    expect(codexTool.parameters.properties.kind.enum).toEqual(["local", "research", "analysis"]);
  });

  it("normalizes input and delegates to an injected supervisor", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-runner-"));
    const supervisor = {
      run: vi.fn(async (request: CodexSupervisorRequest) => ({
        ok: true as const,
        status: "succeeded" as const,
        jobId: request.jobId,
        kind: request.kind,
        content: request.task
      }))
    };
    const runner = new CodexToolRunner(supervisor);

    const result = await runner.run(
      { task: "  inspect this  ", kind: "local", __sunabot_admin_authorized: true },
      { jobId: "job-runner", jobDir: temporaryRoot }
    );

    expect(result).toMatchObject({ status: "succeeded", content: "inspect this" });
    expect(supervisor.run).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "job-runner",
      task: "inspect this",
      kind: "local"
    }));
  });

  it("rejects malformed model arguments before invoking the supervisor", async () => {
    const supervisor = { run: vi.fn() };
    const runner = new CodexToolRunner(supervisor);

    const result = await runner.run(
      { task: "", kind: "search", __sunabot_admin_authorized: true },
      { jobId: "job-invalid", jobDir: "/tmp/job-invalid" }
    );

    expect(result).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
    expect(supervisor.run).not.toHaveBeenCalled();
  });

  it("rejects a worker call that was not authorized by an administrator turn", async () => {
    const supervisor = { run: vi.fn() };
    const runner = new CodexToolRunner(supervisor);

    const result = await runner.run(
      { task: "modify the workspace", kind: "local" },
      { jobId: "job-unauthorized", jobDir: "/tmp/job-unauthorized" }
    );

    expect(result).toMatchObject({ status: "failed", error: { code: "admin_unauthorized" } });
    expect(supervisor.run).not.toHaveBeenCalled();
  });
});

describe("Codex JSONL lifecycle", () => {
  it("parses streamed lifecycle, item, final message and usage events", () => {
    const parser = new CodexJsonlLifecycleParser();
    parser.push('{"type":"thread.started","thread_id":"thread-1"}\n{"type":"turn.started"}\n');
    parser.push('{"type":"item.started","item":{"id":"item_0","type":"command_execution"}}\n');
    parser.push('{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"done"}}\n');
    parser.push('{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}');
    parser.finish();

    expect(parser.snapshot).toMatchObject({
      threadId: "thread-1",
      turnStarted: true,
      turnCompleted: true,
      turnFailed: false,
      lastAgentText: "done",
      usage: { input_tokens: 12, output_tokens: 3 }
    });
    expect(parser.snapshot.itemTypes).toEqual(["command_execution", "agent_message"]);
  });

  it("captures failed turns and rejects malformed JSONL", () => {
    const failed = new CodexJsonlLifecycleParser();
    failed.push('{"type":"error","message":"upstream unavailable"}\n');
    failed.push('{"type":"turn.failed","error":{"message":"request failed"}}\n');
    expect(failed.snapshot).toMatchObject({
      turnFailed: true,
      failureMessage: "request failed",
      errorMessages: ["upstream unavailable"]
    });

    const malformed = new CodexJsonlLifecycleParser();
    expect(() => malformed.push("not-json\n")).toThrow(CodexProtocolError);
  });

  it("marks aggregate stdout beyond 4 MiB as truncated and keeps parsing terminal events", () => {
    const parser = new CodexJsonlLifecycleParser();
    const boundaryLine = jsonLineWithBytes(CODEX_MAX_JSONL_LINE_BYTES);
    for (let index = 0; index < CODEX_MAX_STDOUT_BYTES / CODEX_MAX_JSONL_LINE_BYTES; index += 1) {
      parser.push(boundaryLine);
    }
    expect(parser.snapshot).toMatchObject({
      outputBytes: CODEX_MAX_STDOUT_BYTES,
      outputTruncated: false
    });

    parser.push('{"type":"turn.completed","usage":{"output_tokens":1}}\n');
    parser.finish();

    expect(parser.snapshot).toMatchObject({
      turnCompleted: true,
      outputTruncated: true,
      usage: { output_tokens: 1 }
    });
  });
});

describe("Codex app-server control", () => {
  it("lists visible local GUI sessions without creating a thread", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-app-list-"));
    const child = fakeChild();
    const requests: Array<Record<string, unknown>> = [];
    attachAppServer(child, requests, (request) => {
      if (request.method === "initialize") return {};
      if (request.method === "thread/list") {
        return {
          data: [
            {
              id: "thread-visible",
              title: "维护 Sunabot",
              cwd: "/Users/admin/Developer/sunabot",
              updatedAt: 123,
              status: { type: "idle" }
            },
            {
              id: "thread-created",
              preview: "",
              cwd: "/Users/admin/Developer/new",
              updatedAt: 124,
              status: { type: "idle" }
            },
            {
              id: "thread-running",
              preview: "执行测试",
              cwd: "/Users/admin/Developer/running",
              updatedAt: 125,
              status: { type: "active", activeFlags: [] }
            },
            {
              id: "thread-failed",
              preview: "失败任务",
              cwd: "/Users/admin/Developer/failed",
              updatedAt: 126,
              status: { type: "systemError" }
            },
            {
              id: "thread-unloaded",
              preview: "尚未载入",
              cwd: "/Users/admin/Developer/unloaded",
              updatedAt: 127,
              status: { type: "notLoaded" }
            }
          ],
          nextCursor: null
        };
      }
      return undefined;
    });
    const runner = new CodexAppServerRunner({
      spawnProcess: () => child,
      signalProcessGroup: vi.fn(),
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      homeDir: temporaryRoot
    });

    const result = await runner.run({
      action: "list_sessions",
      ssh_host: null,
      task: null,
      workspace_path: null,
      thread_id: null,
      query: null,
      limit: 10,
      __sunabot_admin_authorized: true,
      __sunabot_control_authorized: true
    }, {
      jobId: "job-list",
      jobDir: temporaryRoot,
      executable: "/custom/codex",
      runToken: "list-run"
    });

    expect(result).toMatchObject({ ok: true, status: "succeeded", kind: "analysis" });
    expect(JSON.parse(result.content ?? "{}")).toMatchObject({
      host: "local",
      sessions: [{
        id: "thread-visible",
        title: "维护 Sunabot",
        cwd: "/Users/admin/Developer/sunabot",
        status: "completed"
      }, {
        id: "thread-created",
        status: "created"
      }, {
        id: "thread-running",
        status: "running"
      }, {
        id: "thread-failed",
        status: "failed"
      }, {
        id: "thread-unloaded",
        status: "notLoaded"
      }]
    });
    expect(requests.map((request) => request.method)).toEqual(["initialize", "initialized", "thread/list"]);
  });

  it("starts a durable workspace-write session and returns its thread ID", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-app-start-"));
    const child = fakeChild();
    const requests: Array<Record<string, unknown>> = [];
    attachAppServer(child, requests, (request) => {
      if (request.method === "initialize") return {};
      if (hasRuntimeWorkspaceRoots(request)) {
        return appServerError(
          -32602,
          "thread/start.runtimeWorkspaceRoots requires the experimentalApi capability"
        );
      }
      if (request.method === "thread/start") return { thread: { id: "thread-new" } };
      if (request.method === "turn/start") {
        queueMicrotask(() => {
          child.stdout?.write(`${JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-foreign",
              item: {
                type: "agentMessage",
                text: JSON.stringify({
                  status: "succeeded",
                  content: "其他任务结果",
                  question: null,
                  error: null
                })
              }
            }
          })}\n`);
          child.stdout?.write(`${JSON.stringify({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-foreign",
              tokenUsage: { last: { inputTokens: 999, outputTokens: 999 } }
            }
          })}\n`);
          child.stdout?.write(`${JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-new",
              item: {
                type: "agentMessage",
                text: JSON.stringify({
                  status: "succeeded",
                  content: "修改与验证完成",
                  question: null,
                  error: null
                })
              }
            }
          })}\n`);
          child.stdout?.write(`${JSON.stringify({
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-new",
              tokenUsage: { last: { inputTokens: 12, outputTokens: 4 } }
            }
          })}\n`);
          child.stdout?.write(`${JSON.stringify({
            method: "turn/completed",
            params: { threadId: "thread-new", turn: { status: "completed" } }
          })}\n`);
        });
        return { turn: { id: "turn-new" } };
      }
      return undefined;
    });
    const runner = new CodexAppServerRunner({
      spawnProcess: () => child,
      signalProcessGroup: vi.fn(),
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      homeDir: temporaryRoot
    });

    const result = await runner.run({
      action: "start",
      ssh_host: null,
      task: "修复测试并验证",
      workspace_path: "/Users/admin/Developer/project",
      thread_id: null,
      query: null,
      limit: null,
      __sunabot_admin_authorized: true,
      __sunabot_control_authorized: true
    }, {
      jobId: "job-start",
      jobDir: temporaryRoot,
      executable: "/custom/codex",
      runToken: "start-run"
    });

    expect(result).toMatchObject({
      ok: true,
      status: "succeeded",
      content: "修改与验证完成",
      threadId: "thread-new",
      usage: { inputTokens: 12, outputTokens: 4 }
    });
    const start = requests.find((request) => request.method === "thread/start");
    expect(start?.params).toMatchObject({
      cwd: "/Users/admin/Developer/project",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: false
    });
    expect(start?.params).not.toHaveProperty("runtimeWorkspaceRoots");
    const turn = requests.find((request) => request.method === "turn/start");
    expect(turn?.params).toMatchObject({
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/Users/admin/Developer/project"],
        networkAccess: true
      }
    });
    expect(turn?.params).not.toHaveProperty("runtimeWorkspaceRoots");
  });

  it("declares experimentalApi before sending runtime workspace roots", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-app-experimental-"));
    const child = fakeChild();
    const requests: Array<Record<string, unknown>> = [];
    attachAppServer(child, requests, (request) => {
      if (request.method === "initialize") return {};
      if (request.method === "thread/start") return { thread: { id: "thread-experimental" } };
      if (request.method === "turn/start") {
        queueMicrotask(() => {
          child.stdout?.write(`${JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-experimental",
              item: {
                type: "agentMessage",
                text: JSON.stringify({
                  status: "succeeded",
                  content: "实验连接完成",
                  question: null,
                  error: null
                })
              }
            }
          })}\n`);
          child.stdout?.write(`${JSON.stringify({
            method: "turn/completed",
            params: { threadId: "thread-experimental", turn: { status: "completed" } }
          })}\n`);
        });
        return { turn: { id: "turn-experimental" } };
      }
      return undefined;
    });
    const runner = new CodexAppServerRunner({
      spawnProcess: () => child,
      signalProcessGroup: vi.fn(),
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      homeDir: temporaryRoot,
      experimentalApi: true
    });

    const result = await runner.run({
      action: "start",
      task: "使用实验工作区",
      workspace_path: "/Users/admin/Developer/project",
      __sunabot_admin_authorized: true,
      __sunabot_control_authorized: true
    }, {
      jobId: "job-experimental",
      jobDir: temporaryRoot,
      executable: "/custom/codex",
      runToken: "experimental-run"
    });

    expect(result).toMatchObject({ ok: true, content: "实验连接完成" });
    expect(requests.find((request) => request.method === "initialize")?.params).toMatchObject({
      capabilities: { experimentalApi: true }
    });
    for (const method of ["thread/start", "turn/start"]) {
      expect(requests.find((request) => request.method === method)?.params).toMatchObject({
        runtimeWorkspaceRoots: ["/Users/admin/Developer/project"]
      });
    }
  });

  it("keeps an app-server result after aggregate stdout exceeds 4 MiB", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-app-output-"));
    const child = fakeChild();
    const requests: Array<Record<string, unknown>> = [];
    attachAppServer(child, requests, (request) => {
      if (request.method === "initialize") return {};
      if (request.method === "thread/start") return { thread: { id: "thread-output" } };
      if (request.method === "turn/start") {
        queueMicrotask(() => {
          for (let index = 0; index < 4; index += 1) {
            child.stdout?.write(jsonLineWithBytes(CODEX_MAX_JSONL_LINE_BYTES, {
              method: "unrelated/progress"
            }));
          }
          child.stdout?.write(`${JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-output",
              item: {
                type: "agentMessage",
                text: JSON.stringify({
                  status: "succeeded",
                  content: "精简结论",
                  question: null,
                  error: null
                })
              }
            }
          })}\n`);
          child.stdout?.write(`${JSON.stringify({
            method: "turn/completed",
            params: { threadId: "thread-output", turn: { status: "completed" } }
          })}\n`);
        });
        return { turn: { id: "turn-output" } };
      }
      return undefined;
    });
    const runner = new CodexAppServerRunner({
      spawnProcess: () => child,
      signalProcessGroup: vi.fn(),
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      homeDir: temporaryRoot
    });

    const result = await runner.run({
      action: "start",
      task: "生成长输出",
      workspace_path: "/Users/admin/Developer/project",
      __sunabot_admin_authorized: true,
      __sunabot_control_authorized: true
    }, {
      jobId: "job-output",
      jobDir: temporaryRoot,
      executable: "/custom/codex",
      runToken: "output-run"
    });

    expect(result).toMatchObject({
      ok: true,
      outputTruncated: true,
      content: expect.stringContaining("精简结论"),
      resultFile: expect.stringContaining("result.json")
    });
    expect(result.content).toContain("输出已截断");
    await expect(fs.readFile(result.resultFile!, "utf8")).resolves.toContain("精简结论");
  });

  it("rejects control calls that were not authorized by the runtime", async () => {
    const runner = new CodexAppServerRunner({
      spawnProcess: vi.fn(),
      environment: {},
      platform: "darwin"
    });
    const result = await runner.run({
      action: "list_sessions",
      ssh_host: null,
      task: null,
      workspace_path: null,
      thread_id: null,
      query: null,
      limit: null
    }, {
      jobId: "job-unauthorized",
      jobDir: "/tmp/job-unauthorized"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "control_unauthorized" }
    });
  });

  it("resumes an exact remote session through the fixed SSH app-server command", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-app-remote-"));
    const child = fakeChild();
    const requests: Array<Record<string, unknown>> = [];
    let command = "";
    let args: string[] = [];
    attachAppServer(child, requests, (request) => {
      if (request.method === "initialize") return {};
      if (hasRuntimeWorkspaceRoots(request)) {
        return appServerError(
          -32602,
          "thread/resume.runtimeWorkspaceRoots requires the experimentalApi capability"
        );
      }
      if (request.method === "thread/resume") return { thread: { id: "thread-remote" } };
      if (request.method === "turn/start") {
        queueMicrotask(() => {
          child.stdout?.write(`${JSON.stringify({
            method: "item/completed",
            params: {
              threadId: "thread-remote",
              item: {
                type: "agentMessage",
                text: JSON.stringify({
                  status: "succeeded",
                  content: "远端修改完成",
                  question: null,
                  error: null
                })
              }
            }
          })}\n`);
          child.stdout?.write(`${JSON.stringify({
            method: "turn/completed",
            params: { threadId: "thread-remote", turn: { status: "completed" } }
          })}\n`);
        });
        return { turn: { id: "turn-remote" } };
      }
      return undefined;
    });
    const runner = new CodexAppServerRunner({
      spawnProcess: (value, valueArgs) => {
        command = value;
        args = valueArgs;
        return child;
      },
      signalProcessGroup: vi.fn(),
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin",
      homeDir: temporaryRoot
    });

    const result = await runner.run({
      action: "resume",
      ssh_host: "development-mac",
      task: "继续修复项目",
      workspace_path: "/Users/admin/Developer/project",
      thread_id: "thread-remote",
      query: null,
      limit: null,
      __sunabot_admin_authorized: true,
      __sunabot_control_authorized: true
    }, {
      jobId: "job-remote",
      jobDir: temporaryRoot,
      runToken: "remote-run"
    });

    expect(result).toMatchObject({
      ok: true,
      content: "远端修改完成",
      threadId: "thread-remote"
    });
    expect(command).toBe("/usr/bin/ssh");
    expect(args).toEqual([
      "-T",
      "-o", "BatchMode=yes",
      "development-mac",
      "env", "SUNABOT_CODEX_RUN_MARKER=remote-run",
      "codex", "app-server", "--stdio"
    ]);
    expect(requests.find((request) => request.method === "thread/resume")?.params).toMatchObject({
      threadId: "thread-remote",
      cwd: "/Users/admin/Developer/project",
      sandbox: "workspace-write"
    });
    expect(requests.find((request) => request.method === "thread/resume")?.params)
      .not.toHaveProperty("runtimeWorkspaceRoots");
  });
});

describe("isolated Codex preparation", () => {
  it("builds a clean environment, copied auth, result file contract, and recursion guard", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-prepare-"));
    const jobDir = path.join(temporaryRoot, "job");
    const authFile = path.join(temporaryRoot, "auth.json");
    await fs.writeFile(authFile, '{"tokens":"test-only"}\n', { mode: 0o600 });
    await fs.chmod(authFile, 0o600);

    const prepared = await prepareCodexRun(baseRequest(jobDir, {
      kind: "research",
      authFile,
      ephemeral: true
    }), {
      environment: {
        PATH: "/usr/bin:/bin",
        HOME: "/real/home",
        CODEX_HOME: "/real/codex-home",
        LANG: "en_US.UTF-8",
        SUNABOT_SECRET: "must-not-leak",
        OPENAI_API_KEY: "must-not-leak"
      },
      platform: "darwin"
    });

    expect(prepared.executable).toBe("/custom/codex");
    expect(prepared.env.HOME).toBe(prepared.homeDir);
    expect(prepared.env.CODEX_HOME).toBe(prepared.codexHomeDir);
    expect(prepared.env.SUNABOT_SECRET).toBeUndefined();
    expect(prepared.env.OPENAI_API_KEY).toBeUndefined();
    expect(prepared.env.PATH?.split(path.delimiter)[0]).toBe(path.join(prepared.runDir, "bin"));
    expect(prepared.args).toEqual(expect.arrayContaining([
      "--sandbox", "workspace-write",
      "--search",
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--json",
      "--output-schema", prepared.schemaFile,
      "--output-last-message", prepared.resultFile,
      "--ephemeral"
    ]));
    expect(prepared.prompt).toContain("Never invoke Codex");
    expect(prepared.prompt).toContain("create research artifacts");

    const copiedAuth = path.join(prepared.codexHomeDir, "auth.json");
    expect(await fs.readFile(copiedAuth, "utf8")).toContain("test-only");
    const copiedStats = await fs.lstat(copiedAuth);
    expect(copiedStats.isSymbolicLink()).toBe(false);
    expect(copiedStats.mode & 0o077).toBe(0);
    expect(await fs.readFile(path.join(prepared.runDir, "bin", "codex"), "utf8"))
      .toContain("Nested Codex invocation is disabled");
  });

  it("isolates the full runtime tree for every attempt token", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-attempts-"));
    const first = await prepareCodexRun(baseRequest(temporaryRoot, {
      attempt: 1,
      runToken: "run-one"
    }), { environment: { PATH: "/usr/bin:/bin" }, platform: "darwin" });
    const second = await prepareCodexRun(baseRequest(temporaryRoot, {
      attempt: 2,
      runToken: "run-two"
    }), { environment: { PATH: "/usr/bin:/bin" }, platform: "darwin" });

    expect(first.runDir).not.toBe(second.runDir);
    expect(first.resultFile.startsWith(`${first.runDir}${path.sep}`)).toBe(true);
    expect(second.resultFile.startsWith(`${second.runDir}${path.sep}`)).toBe(true);
    expect(first.homeDir).not.toBe(second.homeDir);
    expect(first.codexHomeDir).not.toBe(second.codexHomeDir);
  });

  it("supports an explicit auth symlink and exact thread resume", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-resume-"));
    const authFile = path.join(temporaryRoot, "auth.json");
    await fs.writeFile(authFile, "{}\n", { mode: 0o600 });
    await fs.chmod(authFile, 0o600);

    const prepared = await prepareCodexRun(baseRequest(path.join(temporaryRoot, "job"), {
      authFile,
      authStrategy: "symlink",
      resumeThreadId: "019f4d1d-374c-7ec3-8abb-d109110ab07e",
      ephemeral: true
    }), { environment: { PATH: "/usr/bin:/bin" }, platform: "darwin" });

    expect((await fs.lstat(path.join(prepared.codexHomeDir, "auth.json"))).isSymbolicLink()).toBe(true);
    const resumeIndex = prepared.args.indexOf("resume");
    expect(resumeIndex).toBeGreaterThan(prepared.args.indexOf("exec"));
    expect(prepared.args).toContain("019f4d1d-374c-7ec3-8abb-d109110ab07e");
    expect(prepared.args).not.toContain("--ephemeral");
  });
});

describe("Codex process supervisor", () => {
  it("uses spawn without a shell, streams stdin, and accepts a completed structured result", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-success-"));
    const child = fakeChild();
    let command = "";
    let args: string[] = [];
    let options: SpawnOptions = {};
    let stdin = "";
    child.stdin?.on("data", (chunk) => { stdin += String(chunk); });
    const spawnProcess: CodexSpawn = (value, valueArgs, valueOptions) => {
      command = value;
      args = valueArgs;
      options = valueOptions;
      queueMicrotask(() => {
        void emitSuccessfulRun(child, valueArgs, {
          status: "succeeded",
          content: "deep result",
          question: null,
          error: null
        });
      });
      return child;
    };
    const supervisor = new CodexProcessSupervisor({
      spawnProcess,
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin"
    });

    const result = await supervisor.run(baseRequest(temporaryRoot));

    expect(result).toMatchObject({
      ok: true,
      status: "succeeded",
      content: "deep result",
      threadId: "thread-test",
      usage: { input_tokens: 10, output_tokens: 4 }
    });
    expect(command).toBe("/custom/codex");
    expect(args).toContain("--json");
    expect(options).toMatchObject({ shell: false, detached: true, cwd: expect.any(String) });
    expect(stdin).toContain("Task:\nInvestigate this deeply.");
  });

  it("returns the result file and concise conclusion when CLI stdout exceeds 4 MiB", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-long-output-"));
    const child = fakeChild();
    const supervisor = new CodexProcessSupervisor({
      spawnProcess: (_command, args) => {
        queueMicrotask(() => {
          for (let index = 0; index < 4; index += 1) {
            child.stdout?.write(jsonLineWithBytes(CODEX_MAX_JSONL_LINE_BYTES));
          }
          void emitSuccessfulRun(child, args, {
            status: "succeeded",
            content: "保留的精简结论",
            question: null,
            error: null
          });
        });
        return child;
      },
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin"
    });

    const result = await supervisor.run(baseRequest(temporaryRoot));

    expect(result).toMatchObject({
      ok: true,
      status: "succeeded",
      outputTruncated: true,
      content: expect.stringContaining("保留的精简结论"),
      resultFile: expect.stringContaining("result.json")
    });
    expect(result.content).toContain("输出已截断");
    await expect(fs.readFile(result.resultFile!, "utf8")).resolves.toContain("保留的精简结论");
  });

  it("persists a unique process identity before monitoring the child", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-identity-"));
    const child = fakeChild();
    const identities: unknown[] = [];
    const supervisor = new CodexProcessSupervisor({
      spawnProcess: (_command, args) => {
        queueMicrotask(() => void emitSuccessfulRun(child, args, {
          status: "succeeded",
          content: "done",
          question: null,
          error: null
        }));
        return child;
      },
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin"
    });

    await supervisor.run(baseRequest(temporaryRoot, {
      attempt: 3,
      runToken: "persisted-run",
      onProcessStarted: (identity) => identities.push(identity)
    }));

    expect(identities).toEqual([expect.objectContaining({
      pid: 4242,
      processGroupId: 4242,
      attempt: 3,
      runToken: "persisted-run",
      commandMarker: expect.stringContaining("attempt-3-persisted-run")
    })]);
  });

  it("maps a structured request for user input to needs_input", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-input-"));
    const child = fakeChild();
    const supervisor = new CodexProcessSupervisor({
      spawnProcess: (_command, args) => {
        queueMicrotask(() => {
          void emitSuccessfulRun(child, args, {
            status: "needs_input",
            content: null,
            question: "Which repository should I inspect?",
            error: null
          });
        });
        return child;
      },
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin"
    });

    const result = await supervisor.run(baseRequest(temporaryRoot));

    expect(result).toMatchObject({
      ok: false,
      status: "needs_input",
      question: "Which repository should I inspect?"
    });
  });

  it("maps a Codex terminal failure without treating stderr as result content", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-failure-"));
    const child = fakeChild();
    const supervisor = new CodexProcessSupervisor({
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stderr?.write("diagnostic only");
          child.stdout?.write('{"type":"thread.started","thread_id":"thread-failed"}\n');
          child.stdout?.write('{"type":"error","message":"provider unavailable"}\n');
          child.stdout?.write('{"type":"turn.failed","error":{"message":"request failed"}}\n');
          child.emit("close", 1, null);
        });
        return child;
      },
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin"
    });

    const result = await supervisor.run(baseRequest(temporaryRoot));

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "codex_turn_failed", message: "request failed" },
      stderr: "diagnostic only"
    });
    expect(result.content).toBeUndefined();
  });

  it("returns unknown when a successful process exit has no terminal lifecycle event", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-unknown-"));
    const child = fakeChild();
    const supervisor = new CodexProcessSupervisor({
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout?.write('{"type":"thread.started","thread_id":"thread-incomplete"}\n');
          child.stdout?.write('{"type":"turn.started"}\n');
          child.emit("close", 0, null);
        });
        return child;
      },
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin"
    });

    const result = await supervisor.run(baseRequest(temporaryRoot));

    expect(result).toMatchObject({
      status: "unknown",
      error: { code: "terminal_event_missing" }
    });
  });

  it("terminates a stubborn process group with SIGTERM then SIGKILL on timeout", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-timeout-"));
    const child = fakeChild();
    const signals: NodeJS.Signals[] = [];
    const supervisor = new CodexProcessSupervisor({
      spawnProcess: () => child,
      signalProcessGroup: (_target, signal) => {
        signals.push(signal);
        if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      },
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin"
    });

    const result = await supervisor.run(baseRequest(temporaryRoot, {
      timeoutMs: 5,
      terminationGraceMs: 5
    }));

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result).toMatchObject({ status: "timed_out", error: { code: "timed_out" } });
  });

  it("cancels an active process without waiting for the task timeout", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-cancel-"));
    const child = fakeChild();
    const controller = new AbortController();
    const signals: NodeJS.Signals[] = [];
    const supervisor = new CodexProcessSupervisor({
      spawnProcess: () => {
        queueMicrotask(() => controller.abort(new Error("user cancelled")));
        return child;
      },
      signalProcessGroup: (_target, signal) => {
        signals.push(signal);
        queueMicrotask(() => child.emit("close", null, signal));
      },
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin"
    });

    const result = await supervisor.run(baseRequest(temporaryRoot, {
      signal: controller.signal,
      timeoutMs: 10_000
    }));

    expect(signals).toEqual(["SIGTERM"]);
    expect(result).toMatchObject({
      status: "cancelled",
      error: { code: "cancelled", message: "user cancelled" }
    });
  });
});

describe("persisted Codex process cleanup", () => {
  const identity = {
    pid: 4242,
    processGroupId: 4242,
    attempt: 1,
    runToken: "old-run",
    commandMarker: "/jobs/job-1/.codex-worker/attempt-1-old-run",
    startedAt: 100
  };

  it("signals only a process group whose command contains the persisted attempt marker", async () => {
    expect(codexProcessInspectionArguments(identity.pid)).toEqual([
      "-ww", "-p", "4242", "-o", "pgid=", "-o", "command="
    ]);
    let alive = true;
    const signals: NodeJS.Signals[] = [];
    const result = await cleanupPersistedCodexProcess(identity, {
      inspectProcess: async () => ({
        processGroupId: 4242,
        command: `/custom/codex --output-last-message ${identity.commandMarker}/result.json`
      }),
      signalProcessGroup: (_group, signal) => {
        signals.push(signal);
        alive = false;
      },
      isProcessGroupAlive: () => alive,
      graceMs: 5,
      pollMs: 1
    });

    expect(result.status).toBe("terminated");
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("refuses to signal a reused PID with a different command marker", async () => {
    const signal = vi.fn();
    const result = await cleanupPersistedCodexProcess(identity, {
      inspectProcess: async () => ({ processGroupId: 4242, command: "/usr/bin/unrelated-service" }),
      signalProcessGroup: signal
    });

    expect(result.status).toBe("unverified");
    expect(signal).not.toHaveBeenCalled();
  });
});

function baseRequest(
  jobDir: string,
  overrides: Partial<CodexSupervisorRequest> = {}
): CodexSupervisorRequest {
  return {
    jobId: "job-test",
    jobDir,
    executable: "/custom/codex",
    task: "Investigate this deeply.",
    kind: "analysis",
    timeoutMs: 2_000,
    terminationGraceMs: 10,
    ...overrides
  };
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child as ChildProcess;
}

function attachAppServer(
  child: ChildProcess,
  requests: Array<Record<string, unknown>>,
  respond: (request: Record<string, unknown>) => unknown
) {
  let buffer = "";
  child.stdin?.on("data", (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line) as Record<string, unknown>;
      requests.push(request);
      if (typeof request.id === "number") {
        const result = respond(request);
        queueMicrotask(() => {
          if (isAppServerError(result)) {
            child.stdout?.write(`${JSON.stringify({ id: request.id, error: result.error })}\n`);
          } else {
            child.stdout?.write(`${JSON.stringify({ id: request.id, result })}\n`);
          }
        });
      } else {
        respond(request);
      }
      newline = buffer.indexOf("\n");
    }
  });
}

function hasRuntimeWorkspaceRoots(request: Record<string, unknown>): boolean {
  const params = request.params;
  return Boolean(
    params
    && typeof params === "object"
    && !Array.isArray(params)
    && Object.prototype.hasOwnProperty.call(params, "runtimeWorkspaceRoots")
  );
}

function appServerError(code: number, message: string) {
  return { __appServerError: true, error: { code, message } };
}

function isAppServerError(
  value: unknown
): value is { __appServerError: true; error: { code: number; message: string } } {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { __appServerError?: unknown }).__appServerError === true
  );
}

function jsonLineWithBytes(
  byteLength: number,
  fields: Record<string, unknown> = { type: "progress" }
) {
  const marker = "__padding__";
  const base = `${JSON.stringify({ ...fields, [marker]: "" })}\n`;
  if (Buffer.byteLength(base) > byteLength) throw new Error("requested JSONL line is too small");
  return base.replace('""}', `"${"x".repeat(byteLength - Buffer.byteLength(base))}"}`);
}

async function emitSuccessfulRun(
  child: ChildProcess,
  args: string[],
  result: { status: string; content: string | null; question: string | null; error: string | null }
) {
  const resultFlag = args.indexOf("--output-last-message");
  const resultFile = args[resultFlag + 1];
  if (!resultFile) throw new Error("result file argument missing");
  await fs.writeFile(resultFile, JSON.stringify(result), "utf8");
  child.stdout?.write('{"type":"thread.started","thread_id":"thread-test"}\n');
  child.stdout?.write('{"type":"turn.started"}\n');
  child.stdout?.write('{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}\n');
  child.stdout?.write('{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":4}}\n');
  child.stdout?.end();
  child.emit("close", 0, null);
}
