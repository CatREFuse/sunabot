import type {
  RuntimeSkillReadResult,
  RuntimeSkillReaderPort
} from "../../services/extensions/public.js";
import type { SkillActivationResource } from "../../packages/contracts/extensions/agentRuntimeExtensions.js";
import { AgentSkillRuntimeReader } from "./agentSkillRuntimeReader.js";
import {
  auditAgentSkillScript,
  buildSkillScriptIndependentAuditInput,
  completeAgentSkillScriptAudit,
  type AgentSkillScriptAuditRunnerPort
} from "./agentSkillScriptAudit.js";
import {
  AgentSkillScriptProjectionBuilder,
  assertPinnedProjectedSkillScript,
  type AgentSkillScriptProjection,
  type AgentSkillScriptProjectionPort
} from "./agentSkillScriptProjection.js";
import {
  SKILL_SCRIPT_MAX_OUTPUT_BYTES,
  StrongIsolatedAgentSkillScriptSandbox,
  type AgentSkillScriptSandboxPort
} from "./agentSkillScriptSandbox.js";

export interface AgentSkillScriptExecutorOptions {
  workspaceRoot: string;
  temporaryRoot?: string;
  reader?: RuntimeSkillReaderPort;
  projection?: AgentSkillScriptProjectionPort;
  sandbox?: AgentSkillScriptSandboxPort;
  auditRunner?: AgentSkillScriptAuditRunnerPort;
  backend?: "auto" | "bubblewrap" | "docker";
  platform?: NodeJS.Platform;
  bwrapExecutable?: string;
  prlimitExecutable?: string;
  dockerExecutable?: string;
  dockerImage?: string;
  dockerEnvironment?: Readonly<Record<string, string>>;
}

export class AgentSkillScriptExecutor {
  private readonly reader: RuntimeSkillReaderPort;
  private readonly projection: AgentSkillScriptProjectionPort;
  private readonly sandbox: AgentSkillScriptSandboxPort;
  private readonly auditRunner?: AgentSkillScriptAuditRunnerPort;

  constructor(options: AgentSkillScriptExecutorOptions) {
    this.reader = options.reader ?? new AgentSkillRuntimeReader({ workspaceRoot: options.workspaceRoot });
    this.auditRunner = options.auditRunner;
    this.projection = options.projection ?? new AgentSkillScriptProjectionBuilder({
      workspaceRoot: options.workspaceRoot,
      temporaryRoot: options.temporaryRoot
    });
    this.sandbox = options.sandbox ?? new StrongIsolatedAgentSkillScriptSandbox({
      backend: options.backend,
      platform: options.platform,
      bwrapExecutable: options.bwrapExecutable,
      prlimitExecutable: options.prlimitExecutable,
      dockerExecutable: options.dockerExecutable,
      dockerImage: options.dockerImage,
      dockerEnvironment: options.dockerEnvironment
    });
  }

  async run(input: {
    agentId: string;
    conversationId: string;
    skillId: string;
    expectedDigestSha256: string;
    resource: SkillActivationResource;
    args: string[];
    outputBudgetBytes?: number;
    signal?: AbortSignal;
  }) {
    const outputBudgetBytes = input.outputBudgetBytes ?? SKILL_SCRIPT_MAX_OUTPUT_BYTES;
    if (!Number.isSafeInteger(outputBudgetBytes) || outputBudgetBytes < 1 ||
        outputBudgetBytes > SKILL_SCRIPT_MAX_OUTPUT_BYTES) {
      throw stableError("SKILL_SCRIPT_LIMIT_INVALID");
    }
    requireExecutorResultBudget(input, outputBudgetBytes);
    if (!this.auditRunner) throw stableError("SKILL_SCRIPT_AUDIT_UNAVAILABLE");
    const before = await readApprovedSkill(this.reader, {
      agentId: input.agentId,
      skillId: input.skillId,
      expectedDigestSha256: input.expectedDigestSha256
    });
    requireResource(before, input.resource, input.expectedDigestSha256);
    let projection: AgentSkillScriptProjection | undefined;
    let script: Buffer | undefined;
    let auditBytes: Buffer | undefined;
    let cleanupError: unknown;
    try {
      projection = await buildProjection(this.projection, {
        agentId: input.agentId,
        skillId: input.skillId,
        expectedDigestSha256: input.expectedDigestSha256,
        resourcePath: input.resource.path,
        expectedResourceSha256: input.resource.sha256,
        expectedResourceBytes: input.resource.bytes
      });
      script = await assertPinnedProjectedSkillScript({
        projection,
        expectedDigestSha256: input.expectedDigestSha256,
        expectedSkillId: input.skillId,
        expectedResourcePath: input.resource.path,
        expectedBytes: input.resource.bytes,
        expectedResourceSha256: input.resource.sha256
      });
      const preflight = auditAgentSkillScript({
        agentId: input.agentId,
        conversationId: input.conversationId,
        skillId: input.skillId,
        expectedDigestSha256: input.expectedDigestSha256,
        resource: input.resource,
        args: input.args,
        bytes: script
      });
      auditBytes = Buffer.from(script);
      const independentInput = buildSkillScriptIndependentAuditInput({
        agentId: input.agentId,
        conversationId: input.conversationId,
        skillId: input.skillId,
        expectedDigestSha256: input.expectedDigestSha256,
        resource: input.resource,
        args: input.args,
        bytes: auditBytes
      }, preflight, input.signal);
      const independent = await runIndependentAudit(this.auditRunner, independentInput);
      const audit = completeAgentSkillScriptAudit(independentInput, independent);
      if (!/^[a-f0-9]{64}$/u.test(audit.fingerprintSha256) ||
          audit.scriptSha256 !== input.resource.sha256 ||
          (audit.interpreter !== "/bin/bash" && audit.interpreter !== "/usr/bin/node")) {
        throw stableError("SKILL_SCRIPT_AUDIT_MISMATCH");
      }
      const after = await readApprovedSkill(this.reader, {
        agentId: input.agentId,
        skillId: input.skillId,
        expectedDigestSha256: input.expectedDigestSha256
      });
      requireResource(after, input.resource, input.expectedDigestSha256);
      if (input.signal?.aborted) throw stableError("SKILL_SCRIPT_ABORTED");
      const result = await this.sandbox.run({
        agentId: input.agentId,
        conversationId: input.conversationId,
        skillId: input.skillId,
        expectedDigestSha256: input.expectedDigestSha256,
        resourcePath: input.resource.path,
        resourceSha256: input.resource.sha256,
        resourceBytes: input.resource.bytes,
        interpreter: audit.interpreter,
        preflightFingerprintSha256: audit.preflightFingerprintSha256,
        auditFingerprintSha256: audit.fingerprintSha256,
        args: [...input.args],
        projection,
        outputBudgetBytes,
        signal: input.signal
      });
      return fitResultToBudget({
        ...result,
        skillId: input.skillId,
        path: input.resource.path,
        digestSha256: input.expectedDigestSha256,
        auditFingerprintSha256: audit.fingerprintSha256
      }, outputBudgetBytes);
    } finally {
      auditBytes?.fill(0);
      script?.fill(0);
      if (projection) {
        try {
          await projection.dispose();
        } catch (error) {
          cleanupError = error;
        }
      }
      if (cleanupError) throw stableError("SKILL_SCRIPT_CLEANUP_FAILED");
    }
  }
}

function fitResultToBudget<T extends {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}>(result: T, maximumBytes: number) {
  if (serializedBytes(result) <= maximumBytes) return result;
  const withoutOutput = {
    ...result,
    stdout: "",
    stderr: "",
    stdoutTruncated: true,
    stderrTruncated: true
  };
  const overhead = serializedBytes(withoutOutput);
  if (overhead > maximumBytes) {
    const minimal = {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: "",
      stderr: "",
      stdoutTruncated: true,
      stderrTruncated: true
    };
    if (serializedBytes(minimal) > maximumBytes) throw stableError("SKILL_SCRIPT_LIMIT_INVALID");
    return minimal;
  }
  const stdoutBytes = Buffer.byteLength(result.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(result.stderr, "utf8");
  let lower = 0;
  let upper = stdoutBytes + stderrBytes;
  let accepted = withoutOutput;
  while (lower <= upper) {
    const allowed = Math.floor((lower + upper) / 2);
    const stdout = truncateUtf8(result.stdout, Math.min(stdoutBytes, allowed));
    const used = Buffer.byteLength(stdout, "utf8");
    const stderr = truncateUtf8(result.stderr, Math.max(0, allowed - used));
    const candidate = {
      ...result,
      stdout,
      stderr,
      stdoutTruncated: result.stdoutTruncated || stdout !== result.stdout,
      stderrTruncated: result.stderrTruncated || stderr !== result.stderr
    };
    if (serializedBytes(candidate) <= maximumBytes) {
      accepted = candidate;
      lower = allowed + 1;
    } else {
      upper = allowed - 1;
    }
  }
  return accepted;
}

function truncateUtf8(value: string, maximumBytes: number) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return value;
  let end = Math.max(0, maximumBytes);
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(encoded.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function serializedBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function requireExecutorResultBudget(
  input: { skillId: string; expectedDigestSha256: string; resource: SkillActivationResource },
  maximumBytes: number
) {
  const minimum = {
    ok: false,
    exitCode: 255,
    stdout: "",
    stderr: "",
    stdoutTruncated: true,
    stderrTruncated: true,
    skillId: input.skillId,
    path: input.resource.path,
    digestSha256: input.expectedDigestSha256,
    auditFingerprintSha256: "a".repeat(64)
  };
  if (serializedBytes(minimum) > maximumBytes) throw stableError("SKILL_SCRIPT_LIMIT_INVALID");
}

function requireResource(
  read: RuntimeSkillReadResult,
  expected: SkillActivationResource,
  expectedDigestSha256: string
) {
  const found = read.resources.find((resource) => resource.path === expected.path);
  if (read.digestSha256 !== expectedDigestSha256 || !found || found.bytes !== expected.bytes ||
      found.sha256 !== expected.sha256 || !found.path.startsWith("scripts/")) {
    throw stableError("SKILL_SCRIPT_RUNTIME_INVALID");
  }
}

async function readApprovedSkill(
  reader: RuntimeSkillReaderPort,
  input: { agentId: string; skillId: string; expectedDigestSha256: string }
) {
  try {
    return await reader.read(input);
  } catch {
    throw stableError("SKILL_SCRIPT_RUNTIME_INVALID");
  }
}

async function runIndependentAudit(
  runner: AgentSkillScriptAuditRunnerPort,
  input: Parameters<AgentSkillScriptAuditRunnerPort["audit"]>[0]
) {
  try {
    return await runner.audit(input);
  } catch (error) {
    if (error instanceof Error && error.name === "SkillScriptError") throw error;
    throw stableError("SKILL_SCRIPT_AUDIT_UNAVAILABLE");
  }
}

async function buildProjection(
  projection: AgentSkillScriptProjectionPort,
  input: Parameters<AgentSkillScriptProjectionPort["build"]>[0]
) {
  try {
    return await projection.build(input);
  } catch (error) {
    if (error instanceof Error && error.name === "SkillScriptError") throw error;
    throw stableError("SKILL_SCRIPT_PROJECTION_INVALID");
  }
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "SkillScriptError";
  return error;
}
