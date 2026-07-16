import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { PARENT_BOUND_FS_WORKER_SOURCE } from "./parentBoundFsWorkerSource.js";

const MAX_WORKER_OUTPUT_BYTES = 16 * 1024;
const MAX_WORKER_STDERR_BYTES = 4 * 1024;
const DEFAULT_WORKER_TIMEOUT_MS = 30_000;
const UNSAFE_BASENAME_PATTERN = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF/\\]/u;
const MAX_BASENAME_BYTES = 240;

export interface ParentBoundDirectoryIdentity {
  realPath: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
}

export interface ParentBoundPathIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  nlink: bigint;
  mode: bigint;
  kind: "directory" | "file";
}

export interface ParentBoundMutationHook {
  beforeCommand?: () => void | Promise<void>;
}

export interface ParentBoundMutationResult {
  result: Record<string, unknown>;
  parentIdentity: ParentBoundPathIdentity;
  parentRealPath: string;
}

export type ParentBoundAtomicReplaceFault =
  | "after_target_rename"
  | "after_target_verify"
  | "after_evidence_verify"
  | "after_fsync"
  | "before_response"
  | "recovery_failure";

export type ParentBoundRenameFault = "after_rename_before_response";

export type ParentBoundWorkerFailureMode =
  | "pause_before_response"
  | "truncate_response";

interface WireIdentity {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  nlink: string;
  mode: string;
  kind: "directory" | "file" | "other";
}

type ParentBoundCommand =
  | {
      op: "mkdir";
      name: string;
      mode: 0o700;
      responseMode: ParentBoundWorkerFailureMode | null;
    }
  | {
      op: "exclusive_write";
      name: string;
      contentBase64: string;
      mode: 0o600;
      faultAt: "before_response" | null;
      responseMode: ParentBoundWorkerFailureMode | null;
    }
  | {
      op: "atomic_replace";
      target: string;
      contentBase64: string;
      mode: 0o600;
      expectedTarget: WireIdentity | null;
      faultAt: ParentBoundAtomicReplaceFault | null;
      operationToken: string;
      commandFingerprint: string;
      contentSha256: string;
      responseMode: ParentBoundWorkerFailureMode | null;
    }
  | {
      op: "create_if_missing";
      target: string;
      contentBase64: string;
      mode: 0o600;
      faultAt: "cleanup_failure" | null;
      operationToken: string;
      commandFingerprint: string;
      contentSha256: string;
      responseMode: ParentBoundWorkerFailureMode | "pause_after_link" | null;
    }
  | {
      op: "rename";
      source: string;
      destination: string;
      expectedSource: WireIdentity;
      faultAt: ParentBoundRenameFault | null;
      responseMode: ParentBoundWorkerFailureMode | null;
    }
  | {
      op: "recover_operation";
      operation: "atomic_replace" | "create_if_missing";
      target: string;
      mode: 0o600;
      expectedTarget: WireIdentity | null;
      operationToken: string;
      commandFingerprint: string;
      contentSha256: string;
      contentBytes: number;
      faultAt: "before_recovery" | null;
    }
  | {
      op: "finalize_operation";
      operation: "atomic_replace" | "create_if_missing";
      target: string;
      mode: 0o600;
      expectedTarget: WireIdentity | null;
      operationToken: string;
      commandFingerprint: string;
      contentSha256: string;
      contentBytes: number;
      resultIdentity: WireIdentity;
      created: boolean;
      responseMode: ParentBoundWorkerFailureMode | null;
    }
  | { op: "sync" };

export class ParentBoundFsError extends Error {
  constructor(public readonly code: string) {
    super("父目录绑定文件操作失败。");
    this.name = "ParentBoundFsError";
  }
}

export async function parentBoundMkdir(input: {
  parent: string;
  parentIdentity: ParentBoundDirectoryIdentity;
  name: string;
  hook?: ParentBoundMutationHook;
  workerFailureMode?: ParentBoundWorkerFailureMode;
  workerTimeoutMs?: number;
}) {
  return runParentBoundMutation({
    parent: input.parent,
    parentIdentity: input.parentIdentity,
    command: {
      op: "mkdir",
      name: safeBasename(input.name),
      mode: 0o700,
      responseMode: input.workerFailureMode ?? null
    },
    hook: input.hook,
    timeoutMs: input.workerTimeoutMs
  });
}

export async function parentBoundExclusiveWrite(input: {
  parent: string;
  parentIdentity: ParentBoundDirectoryIdentity;
  name: string;
  content: Buffer;
  hook?: ParentBoundMutationHook;
  faultAt?: "before_response";
  workerFailureMode?: ParentBoundWorkerFailureMode;
  workerTimeoutMs?: number;
}) {
  return runParentBoundMutation({
    parent: input.parent,
    parentIdentity: input.parentIdentity,
    command: {
      op: "exclusive_write",
      name: safeBasename(input.name),
      contentBase64: boundedContent(input.content),
      mode: 0o600,
      faultAt: input.faultAt ?? null,
      responseMode: input.workerFailureMode ?? null
    },
    hook: input.hook,
    timeoutMs: input.workerTimeoutMs
  });
}

export async function parentBoundAtomicReplace(input: {
  filePath: string;
  parentIdentity: ParentBoundDirectoryIdentity;
  content: Buffer;
  expectedTarget: BigIntStats | null;
  hook?: ParentBoundMutationHook;
  faultAt?: ParentBoundAtomicReplaceFault;
  workerFailureMode?: ParentBoundWorkerFailureMode;
  finalizeWorkerFailureMode?: ParentBoundWorkerFailureMode;
  workerTimeoutMs?: number;
}) {
  const { parent, name } = splitBoundPath(input.filePath);
  const expectedTarget = input.expectedTarget ? serializeStats(input.expectedTarget) : null;
  return runRecoverableFileMutation({
    parent,
    parentIdentity: input.parentIdentity,
    operation: "atomic_replace",
    target: name,
    content: input.content,
    expectedTarget,
    faultAt: input.faultAt ?? null,
    responseMode: input.workerFailureMode ?? null,
    finalizeResponseMode: input.finalizeWorkerFailureMode ?? null,
    timeoutMs: input.workerTimeoutMs,
    hook: input.hook
  });
}

export async function parentBoundCreateIfMissing(input: {
  filePath: string;
  parentIdentity: ParentBoundDirectoryIdentity;
  content: Buffer;
  hook?: ParentBoundMutationHook;
  faultAt?: "cleanup_failure";
  workerFailureMode?: ParentBoundWorkerFailureMode | "pause_after_link";
  finalizeWorkerFailureMode?: ParentBoundWorkerFailureMode;
  workerTimeoutMs?: number;
}) {
  const { parent, name } = splitBoundPath(input.filePath);
  return runRecoverableFileMutation({
    parent,
    parentIdentity: input.parentIdentity,
    operation: "create_if_missing",
    target: name,
    content: input.content,
    expectedTarget: null,
    faultAt: input.faultAt ?? null,
    responseMode: input.workerFailureMode ?? null,
    finalizeResponseMode: input.finalizeWorkerFailureMode ?? null,
    timeoutMs: input.workerTimeoutMs,
    hook: input.hook
  });
}

async function runRecoverableFileMutation(input: {
  parent: string;
  parentIdentity: ParentBoundDirectoryIdentity;
  operation: "atomic_replace" | "create_if_missing";
  target: string;
  content: Buffer;
  expectedTarget: WireIdentity | null;
  faultAt: ParentBoundAtomicReplaceFault | "cleanup_failure" | null;
  responseMode: ParentBoundWorkerFailureMode | "pause_after_link" | null;
  finalizeResponseMode: ParentBoundWorkerFailureMode | null;
  timeoutMs?: number;
  hook?: ParentBoundMutationHook;
}) {
  const contentBase64 = boundedContent(input.content);
  const contentSha256 = createHash("sha256").update(input.content).digest("hex");
  const operationToken = randomUUID();
  const descriptor = {
    operation: input.operation,
    target: input.target,
    contentSha256,
    contentBytes: input.content.length,
    mode: 0o600 as const,
    expectedTarget: input.expectedTarget
  };
  const commandFingerprint = operationFingerprint(descriptor);
  const recoveryCommand: Extract<ParentBoundCommand, { op: "recover_operation" }> = {
    op: "recover_operation",
    ...descriptor,
    operationToken,
    commandFingerprint,
    faultAt: input.faultAt === "recovery_failure" ? "before_recovery" : null
  };
  const primaryCommand: ParentBoundCommand = input.operation === "atomic_replace"
    ? {
        op: "atomic_replace",
        target: input.target,
        contentBase64,
        mode: 0o600,
        expectedTarget: input.expectedTarget,
        faultAt: input.faultAt as ParentBoundAtomicReplaceFault | null,
        operationToken,
        commandFingerprint,
        contentSha256,
        responseMode: input.responseMode === "pause_after_link" ? null : input.responseMode
      }
    : {
        op: "create_if_missing",
        target: input.target,
        contentBase64,
        mode: 0o600,
        faultAt: input.faultAt === "cleanup_failure" ? input.faultAt : null,
        operationToken,
        commandFingerprint,
        contentSha256,
        responseMode: input.responseMode
      };

  let outcome: ParentBoundMutationResult;
  try {
    outcome = await runParentBoundMutation({
      parent: input.parent,
      parentIdentity: input.parentIdentity,
      command: primaryCommand,
      hook: input.hook,
      timeoutMs: input.timeoutMs
    });
    validateRecoverableResult(input.operation, outcome.result, operationToken, input.expectedTarget !== null);
  } catch (error) {
    try {
      const recovery = await runParentBoundMutation({
        parent: input.parent,
        parentIdentity: input.parentIdentity,
        command: recoveryCommand,
        allowParentCtimeChange: true
      });
      const result = exactObject(recovery.result, ["recovered"]);
      if (result.recovered !== true) throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
    } catch {
      throw new ParentBoundFsError("BOUND_RECOVERY_REQUIRED");
    }
    throw error;
  }

  const resultIdentity = recoverableResultIdentity(outcome.result);
  const created = input.operation === "create_if_missing"
    ? exactObject(outcome.result, ["created", "identity"]).created === true
    : true;
  const finalizeCommand = {
    op: "finalize_operation" as const,
    ...descriptor,
    operationToken,
    commandFingerprint,
    resultIdentity: serializeIdentity(resultIdentity),
    created
  };
  const finalParent: ParentBoundDirectoryIdentity = {
    realPath: outcome.parentRealPath,
    dev: outcome.parentIdentity.dev,
    ino: outcome.parentIdentity.ino,
    ctimeNs: outcome.parentIdentity.ctimeNs
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const finalized = await runParentBoundMutation({
        parent: finalParent.realPath,
        parentIdentity: finalParent,
        command: {
          ...finalizeCommand,
          responseMode: attempt === 0 ? input.finalizeResponseMode : null
        },
        allowParentCtimeChange: true
      });
      const result = exactObject(finalized.result, ["finalized"]);
      if (result.finalized !== true) throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
      return {
        ...outcome,
        parentIdentity: finalized.parentIdentity,
        parentRealPath: finalized.parentRealPath
      };
    } catch {
      if (attempt === 1) throw new ParentBoundFsError("BOUND_RECOVERY_REQUIRED");
    }
  }
  throw new ParentBoundFsError("BOUND_RECOVERY_REQUIRED");
}

function recoverableResultIdentity(result: Record<string, unknown>) {
  if (!("identity" in result)) throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
  return parseWireIdentity(result.identity);
}

function validateRecoverableResult(
  operation: "atomic_replace" | "create_if_missing",
  result: Record<string, unknown>,
  operationToken: string,
  hadExpectedTarget: boolean
) {
  if (operation === "atomic_replace") {
    const value = exactObject(result, ["identity", "quarantine"]);
    parseWireIdentity(value.identity);
    const expectedQuarantine = hadExpectedTarget ? `.bound-quarantine-${operationToken}` : null;
    if (value.quarantine !== expectedQuarantine) throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
    return;
  }
  const value = exactObject(result, ["created", "identity"]);
  if (typeof value.created !== "boolean") throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
  parseWireIdentity(value.identity);
}

function operationFingerprint(value: {
  operation: "atomic_replace" | "create_if_missing";
  target: string;
  contentSha256: string;
  contentBytes: number;
  mode: 0o600;
  expectedTarget: WireIdentity | null;
}) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function parentBoundRename(input: {
  source: string;
  destination: string;
  parentIdentity: ParentBoundDirectoryIdentity;
  expectedSource: BigIntStats | ParentBoundPathIdentity;
  hook?: ParentBoundMutationHook;
  faultAt?: ParentBoundRenameFault;
  workerFailureMode?: ParentBoundWorkerFailureMode;
  workerTimeoutMs?: number;
}) {
  const source = splitBoundPath(input.source);
  const destination = splitBoundPath(input.destination);
  if (source.parent !== destination.parent) {
    throw new ParentBoundFsError("BOUND_CROSS_PARENT_RENAME_REJECTED");
  }
  return runParentBoundMutation({
    parent: source.parent,
    parentIdentity: input.parentIdentity,
    command: {
      op: "rename",
      source: source.name,
      destination: destination.name,
      expectedSource: isBigIntStats(input.expectedSource)
        ? serializeStats(input.expectedSource)
        : serializeIdentity(input.expectedSource),
      faultAt: input.faultAt ?? null,
      responseMode: input.workerFailureMode ?? null
    },
    hook: input.hook,
    timeoutMs: input.workerTimeoutMs
  });
}

export async function parentBoundSync(input: {
  directory: string;
  identity: ParentBoundDirectoryIdentity;
  hook?: ParentBoundMutationHook;
}) {
  return runParentBoundMutation({
    parent: path.resolve(input.directory),
    parentIdentity: input.identity,
    command: { op: "sync" },
    hook: input.hook
  });
}

export function pathIdentityFromStats(stat: BigIntStats): ParentBoundPathIdentity {
  const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
  if (!kind) throw new ParentBoundFsError("BOUND_SOURCE_TYPE_INVALID");
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    nlink: stat.nlink,
    mode: stat.mode,
    kind
  };
}

export function parseParentBoundPathIdentity(value: unknown) {
  return parseWireIdentity(value);
}

export async function runParentBoundMutation(input: {
  parent: string;
  parentIdentity: ParentBoundDirectoryIdentity;
  command: ParentBoundCommand;
  hook?: ParentBoundMutationHook;
  timeoutMs?: number;
  allowParentCtimeChange?: boolean;
}): Promise<ParentBoundMutationResult> {
  const parent = path.resolve(input.parent);
  if (parent !== input.parentIdentity.realPath) {
    throw new ParentBoundFsError("BOUND_PARENT_REALPATH_MISMATCH");
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new ParentBoundFsError("BOUND_TIMEOUT_INVALID");
  }
  return new Promise<ParentBoundMutationResult>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", PARENT_BOUND_FS_WORKER_SOURCE],
      {
        cwd: parent,
        env: {},
        shell: false,
        detached: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      }
    );
    let state: "ready" | "result" | "done" = "ready";
    let stdoutBuffer = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: Error | null = null;
    let success: ParentBoundMutationResult | null = null;
    let closed = false;
    let processing = Promise.resolve();

    const fail = (error: unknown) => {
      if (!failure) {
        failure = error instanceof Error ? error : new ParentBoundFsError("BOUND_WORKER_FAILED");
      }
      if (!closed) child.kill("SIGKILL");
    };

    const processLine = async (line: string) => {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
      }
      if (state === "ready") {
        const ready = exactObject(value, ["phase", "realPath", "identity"]);
        if (ready.phase !== "ready" || ready.realPath !== input.parentIdentity.realPath) {
          throw new ParentBoundFsError("BOUND_PARENT_CHANGED");
        }
        const identity = parseWireIdentity(ready.identity);
        if (identity.kind !== "directory" || identity.dev !== input.parentIdentity.dev ||
            identity.ino !== input.parentIdentity.ino ||
            (!input.allowParentCtimeChange && identity.ctimeNs !== input.parentIdentity.ctimeNs)) {
          throw new ParentBoundFsError("BOUND_PARENT_CHANGED");
        }
        await input.hook?.beforeCommand?.();
        state = "result";
        child.stdin.end(`${JSON.stringify({
          phase: "execute",
          expectedParent: {
            dev: input.parentIdentity.dev.toString(),
            ino: input.parentIdentity.ino.toString()
          },
          command: input.command
        })}\n`);
        return;
      }
      if (state !== "result") throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
      const result = value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
      if (result.phase !== "result" || typeof result.ok !== "boolean") {
        throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
      }
      if (!result.ok) {
        if (Object.keys(result).sort().join(",") !== "code,ok,phase" ||
            typeof result.code !== "string" || !/^(?:E[A-Z0-9]+|BOUND_[A-Z0-9_]+)$/u.test(result.code)) {
          throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
        }
        throw new ParentBoundFsError(result.code);
      }
      if (Object.keys(result).sort().join(",") !== "ok,parentIdentity,parentRealPath,phase,result") {
        throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
      }
      const parentIdentity = parseWireIdentity(result.parentIdentity);
      if (parentIdentity.kind !== "directory" || parentIdentity.dev !== input.parentIdentity.dev ||
          parentIdentity.ino !== input.parentIdentity.ino) {
        throw new ParentBoundFsError("BOUND_PARENT_CHANGED");
      }
      if (!result.result || typeof result.result !== "object" || Array.isArray(result.result)) {
        throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
      }
      if (typeof result.parentRealPath !== "string" || !path.isAbsolute(result.parentRealPath)) {
        throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
      }
      success = {
        result: result.result as Record<string, unknown>,
        parentIdentity,
        parentRealPath: result.parentRealPath
      };
      state = "done";
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_WORKER_OUTPUT_BYTES) {
        fail(new ParentBoundFsError("BOUND_PROTOCOL_LIMIT"));
        return;
      }
      stdoutBuffer += chunk.toString("utf8");
      while (stdoutBuffer.includes("\n")) {
        const newline = stdoutBuffer.indexOf("\n");
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        processing = processing.then(() => processLine(line)).catch(fail);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_WORKER_STDERR_BYTES) fail(new ParentBoundFsError("BOUND_STDERR_LIMIT"));
    });
    child.stdin.on("error", () => fail(new ParentBoundFsError("BOUND_WORKER_STDIN_FAILED")));
    child.on("error", () => fail(new ParentBoundFsError("BOUND_WORKER_SPAWN_FAILED")));
    const timer = setTimeout(() => fail(new ParentBoundFsError("BOUND_WORKER_TIMEOUT")), timeoutMs);
    timer.unref();
    child.on("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      if (failure) {
        reject(failure);
        return;
      }
      void processing.then(() => {
        if (stdoutBuffer.trim()) failure ??= new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
        if (failure) {
          reject(failure);
        } else if (!success || state !== "done" || code !== 0 || signal) {
          reject(new ParentBoundFsError("BOUND_WORKER_FAILED"));
        } else {
          resolve(success);
        }
      });
    });
  });
}

function splitBoundPath(filePath: string) {
  const absolute = path.resolve(filePath);
  return { parent: path.dirname(absolute), name: safeBasename(path.basename(absolute)) };
}

function safeBasename(value: string) {
  if (!value || value === "." || value === ".." || value.normalize("NFC") !== value ||
      Buffer.byteLength(value, "utf8") > MAX_BASENAME_BYTES || UNSAFE_BASENAME_PATTERN.test(value)) {
    throw new ParentBoundFsError("BOUND_BASENAME_INVALID");
  }
  return value;
}

function boundedContent(content: Buffer) {
  if (!Buffer.isBuffer(content) || content.length > 32 * 1024 * 1024) {
    throw new ParentBoundFsError("BOUND_CONTENT_INVALID");
  }
  return content.toString("base64");
}

function serializeStats(stat: BigIntStats): WireIdentity {
  return serializeIdentity(pathIdentityFromStats(stat));
}

function serializeIdentity(identity: ParentBoundPathIdentity): WireIdentity {
  return {
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    size: identity.size.toString(),
    mtimeNs: identity.mtimeNs.toString(),
    ctimeNs: identity.ctimeNs.toString(),
    nlink: identity.nlink.toString(),
    mode: identity.mode.toString(),
    kind: identity.kind
  };
}

function parseWireIdentity(value: unknown): ParentBoundPathIdentity {
  const object = exactObject(value, ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode", "kind"]);
  if (object.kind !== "directory" && object.kind !== "file") {
    throw new ParentBoundFsError("BOUND_IDENTITY_INVALID");
  }
  return {
    dev: bigintValue(object.dev),
    ino: bigintValue(object.ino),
    size: bigintValue(object.size),
    mtimeNs: bigintValue(object.mtimeNs),
    ctimeNs: bigintValue(object.ctimeNs),
    nlink: bigintValue(object.nlink),
    mode: bigintValue(object.mode),
    kind: object.kind
  };
}

function bigintValue(value: unknown) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new ParentBoundFsError("BOUND_IDENTITY_INVALID");
  }
  return BigInt(value);
}

function exactObject(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new ParentBoundFsError("BOUND_PROTOCOL_INVALID");
  }
  return object;
}

function isBigIntStats(value: BigIntStats | ParentBoundPathIdentity): value is BigIntStats {
  return typeof (value as BigIntStats).isDirectory === "function";
}
