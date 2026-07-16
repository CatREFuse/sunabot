import { PARENT_BOUND_FS_WORKER_OPERATIONS_SOURCE } from "./parentBoundFsWorkerOperationsSource.js";

/** Fixed protocol and bootstrap source executed only through the absolute current Node executable. */
const PARENT_BOUND_FS_WORKER_BOOTSTRAP_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
const MAX_COMMAND_BYTES = 48 * 1024 * 1024;
const MAX_CONTENT_BYTES = 32 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;
const UNSAFE_BASENAME_PATTERN = /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF/\\]/u;
const MAX_BASENAME_BYTES = 240;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function safeErrorCode(error) {
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
  if (/^E[A-Z0-9]+$/u.test(code)) return code;
  if (/^BOUND_[A-Z0-9_]+$/u.test(code)) return code;
  return "BOUND_WORKER_FAILED";
}
function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("BOUND_PROTOCOL_INVALID");
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("BOUND_PROTOCOL_INVALID");
  }
  return value;
}
function basename(value) {
  if (typeof value !== "string" || !value || value === "." || value === ".." ||
      value.normalize("NFC") !== value || Buffer.byteLength(value, "utf8") > MAX_BASENAME_BYTES ||
      UNSAFE_BASENAME_PATTERN.test(value)) {
    fail("BOUND_BASENAME_INVALID");
  }
  return value;
}
function mode(value) {
  if (value !== 0o600 && value !== 0o700) fail("BOUND_MODE_INVALID");
  return value;
}
function configuredFault(value, allowed) {
  if (value === null) return null;
  if (typeof value !== "string" || !allowed.includes(value)) fail("BOUND_PROTOCOL_INVALID");
  return value;
}
function configuredResponse(value, extra = []) {
  return configuredFault(value, ["pause_before_response", "truncate_response", ...extra]);
}
function injectFault(configured, current) {
  if (configured === current) fail("BOUND_INJECTED_FAULT");
}
function token(value) {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) fail("BOUND_PROTOCOL_INVALID");
  return value;
}
function digest(value) {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) fail("BOUND_PROTOCOL_INVALID");
  return value;
}
function byteLength(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_CONTENT_BYTES) fail("BOUND_PROTOCOL_INVALID");
  return value;
}
function serializeIdentity(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    nlink: stat.nlink.toString(),
    mode: stat.mode.toString(),
    kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other"
  };
}
function bigintField(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) fail("BOUND_IDENTITY_INVALID");
  return BigInt(value);
}

function expectedIdentity(value) {
  const object = exactObject(value, ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink", "mode", "kind"]);
  if (object.kind !== "directory" && object.kind !== "file") fail("BOUND_IDENTITY_INVALID");
  return {
    dev: bigintField(object.dev),
    ino: bigintField(object.ino),
    size: bigintField(object.size),
    mtimeNs: bigintField(object.mtimeNs),
    ctimeNs: bigintField(object.ctimeNs),
    nlink: bigintField(object.nlink),
    mode: bigintField(object.mode),
    kind: object.kind
  };
}

function sameIdentity(stat, expected, allowRenameCtime = false, allowNlinkChange = false) {
  const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
  return stat.dev === expected.dev && stat.ino === expected.ino && stat.size === expected.size &&
    stat.mtimeNs === expected.mtimeNs && (allowRenameCtime || stat.ctimeNs === expected.ctimeNs) &&
    (allowNlinkChange || stat.nlink === expected.nlink) && stat.mode === expected.mode && kind === expected.kind;
}

function sameWireIdentity(left, right) {
  if (left === null || right === null) return left === right;
  const a = expectedIdentity(left);
  const b = expectedIdentity(right);
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs && a.nlink === b.nlink && a.mode === b.mode && a.kind === b.kind;
}

function matchesOriginal(stat, expected) {
  return expected.kind === "file" && stat.isFile() && !stat.isSymbolicLink() &&
    stat.dev === expected.dev && stat.ino === expected.ino && stat.size === expected.size &&
    stat.mtimeNs === expected.mtimeNs && stat.mode === expected.mode;
}

async function lstatOptional(name) {
  try {
    return await fs.lstat(name, { bigint: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

async function syncCwd() {
  const handle = await fs.open(".", fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readCommand() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes > MAX_COMMAND_BYTES - buffer.length) fail("BOUND_PROTOCOL_LIMIT");
    bytes += buffer.length;
    chunks.push(buffer);
  }
  const input = Buffer.concat(chunks, bytes).toString("utf8");
  if (!input.endsWith("\n") || input.slice(0, -1).includes("\n")) fail("BOUND_PROTOCOL_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(input.slice(0, -1));
  } catch {
    fail("BOUND_PROTOCOL_INVALID");
  }
  return exactObject(parsed, ["phase", "expectedParent", "command"]);
}

function decodeContent(value) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_CONTENT_BYTES / 3) * 4 ||
      value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail("BOUND_CONTENT_INVALID");
  }
  const content = Buffer.from(value, "base64");
  if (content.length > MAX_CONTENT_BYTES || content.toString("base64") !== value) fail("BOUND_CONTENT_INVALID");
  return content;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function writeExclusive(name, content, fileMode) {
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(
    name,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
    fileMode
  );
  try {
    await handle.writeFile(content);
    await handle.sync();
    const handleStat = await handle.stat({ bigint: true });
    const pathStat = await fs.lstat(name, { bigint: true });
    if (!handleStat.isFile() || handleStat.nlink !== 1n || handleStat.size !== BigInt(content.length) ||
        !sameIdentity(pathStat, expectedIdentity(serializeIdentity(handleStat)))) {
      fail("BOUND_WRITE_IDENTITY_CHANGED");
    }
    return pathStat;
  } finally {
    await handle.close();
  }
}

async function readStrictJson(name) {
  const before = await fs.lstat(name, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o600n || before.size > BigInt(MAX_EVIDENCE_BYTES)) {
    fail("BOUND_RECOVERY_REQUIRED");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(name, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameIdentity(opened, expectedIdentity(serializeIdentity(before)))) fail("BOUND_RECOVERY_REQUIRED");
    const content = await handle.readFile();
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await fs.lstat(name, { bigint: true });
    if (!sameIdentity(afterHandle, expectedIdentity(serializeIdentity(before))) ||
        !sameIdentity(afterPath, expectedIdentity(serializeIdentity(before))) ||
        content.length !== Number(before.size) || !content.toString("utf8").endsWith("\n")) {
      fail("BOUND_RECOVERY_REQUIRED");
    }
    let value;
    try {
      value = JSON.parse(content.toString("utf8").slice(0, -1));
    } catch {
      fail("BOUND_RECOVERY_REQUIRED");
    }
    return { value, identity: before };
  } finally {
    await handle.close();
  }
}

async function writeStrictJson(name, value) {
  return writeExclusive(name, Buffer.from(JSON.stringify(value) + "\n"), 0o600);
}

async function removeEvidence(name, identity) {
  const current = await fs.lstat(name, { bigint: true });
  if (!sameIdentity(current, expectedIdentity(serializeIdentity(identity)))) fail("BOUND_RECOVERY_REQUIRED");
  await fs.unlink(name);
  if (await lstatOptional(name)) fail("BOUND_RECOVERY_REQUIRED");
}

async function moveKnownEntry(source, destination, expected) {
  if (await lstatOptional(destination)) fail("EEXIST");
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await fs.open(source, fsConstants.O_RDONLY | noFollow);
  let destinationReserved = false;
  let renamed = false;
  try {
    const before = await handle.stat({ bigint: true });
    const atPath = await fs.lstat(source, { bigint: true });
    if (!sameIdentity(before, expected) || !sameIdentity(atPath, expected)) fail("BOUND_SOURCE_CHANGED");
    if (expected.kind === "file") {
      try {
        await fs.link(source, destination);
      } catch (error) {
        if (error && typeof error === "object" && error.code === "EEXIST") fail("EEXIST");
        throw error;
      }
      destinationReserved = true;
      const linkedSource = await fs.lstat(source, { bigint: true });
      const linkedDestination = await fs.lstat(destination, { bigint: true });
      if (!linkedSource.isFile() || !linkedDestination.isFile() ||
          linkedSource.dev !== before.dev || linkedSource.ino !== before.ino ||
          linkedDestination.dev !== before.dev || linkedDestination.ino !== before.ino ||
          linkedSource.nlink !== before.nlink + 1n || linkedDestination.nlink !== before.nlink + 1n) {
        fail("BOUND_RENAME_IDENTITY_CHANGED");
      }
      await fs.unlink(source);
      renamed = true;
    } else {
      try {
        await fs.mkdir(destination, { mode: 0o700 });
      } catch (error) {
        if (error && typeof error === "object" && error.code === "EEXIST") fail("EEXIST");
        throw error;
      }
      destinationReserved = true;
      const reservation = await fs.lstat(destination, { bigint: true });
      if (!reservation.isDirectory() || reservation.isSymbolicLink()) fail("BOUND_RENAME_IDENTITY_CHANGED");
      await fs.rename(source, destination);
      renamed = true;
    }
    const afterHandle = await handle.stat({ bigint: true });
    const moved = await fs.lstat(destination, { bigint: true });
    if (!sameIdentity(afterHandle, expected, true) || moved.dev !== before.dev || moved.ino !== before.ino ||
        moved.size !== before.size || moved.mtimeNs !== before.mtimeNs || moved.nlink !== before.nlink) {
      fail("BOUND_RENAME_IDENTITY_CHANGED");
    }
    return moved;
  } finally {
    await handle.close();
    if (destinationReserved && !renamed) {
      try {
        const reservation = await fs.lstat(destination, { bigint: true });
        if (expected.kind === "file") {
          const sourceStat = await lstatOptional(source);
          if (sourceStat && reservation.isFile() && reservation.dev === sourceStat.dev &&
              reservation.ino === sourceStat.ino) await fs.unlink(destination);
        } else if (reservation.isDirectory() && !reservation.isSymbolicLink()) {
          await fs.rmdir(destination);
        }
      } catch {}
    }
  }
}
`;

const PARENT_BOUND_FS_WORKER_MAIN_SOURCE = String.raw`
async function execute(command) {
  if (!command || typeof command !== "object" || Array.isArray(command) || typeof command.op !== "string") {
    fail("BOUND_PROTOCOL_INVALID");
  }
  if (command.op === "mkdir") {
    const object = exactObject(command, ["op", "name", "mode", "responseMode"]);
    configuredResponse(object.responseMode);
    const name = basename(object.name);
    const directoryMode = mode(object.mode);
    let created = false;
    try {
      await fs.mkdir(name, { mode: directoryMode });
      created = true;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(name, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("BOUND_DIRECTORY_INVALID");
    await syncCwd();
    return { created, identity: serializeIdentity(stat) };
  }
  if (command.op === "exclusive_write") {
    const object = exactObject(command, ["op", "name", "contentBase64", "mode", "faultAt", "responseMode"]);
    configuredResponse(object.responseMode);
    const fault = configuredFault(object.faultAt, ["before_response"]);
    const name = basename(object.name);
    const stat = await writeExclusive(name, decodeContent(object.contentBase64), mode(object.mode));
    await syncCwd();
    injectFault(fault, "before_response");
    return { identity: serializeIdentity(stat) };
  }
  if (command.op === "atomic_replace") return atomicReplace(command);
  if (command.op === "create_if_missing") return createIfMissing(command);
  if (command.op === "rename") {
    const object = exactObject(command, [
      "op", "source", "destination", "expectedSource", "faultAt", "responseMode"
    ]);
    configuredResponse(object.responseMode);
    const fault = configuredFault(object.faultAt, ["after_rename_before_response"]);
    const moved = await moveKnownEntry(
      basename(object.source),
      basename(object.destination),
      expectedIdentity(object.expectedSource)
    );
    await syncCwd();
    injectFault(fault, "after_rename_before_response");
    return { identity: serializeIdentity(moved) };
  }
  if (command.op === "recover_operation") return recoverOperation(command);
  if (command.op === "finalize_operation") return finalizeOperation(command);
  if (command.op === "sync") {
    exactObject(command, ["op"]);
    await syncCwd();
    return {};
  }
  fail("BOUND_OPERATION_INVALID");
}

try {
  const initial = await fs.lstat(".", { bigint: true });
  if (!initial.isDirectory() || initial.isSymbolicLink()) fail("BOUND_PARENT_INVALID");
  const realPath = await fs.realpath(".");
  const afterRealpath = await fs.lstat(".", { bigint: true });
  if (initial.dev !== afterRealpath.dev || initial.ino !== afterRealpath.ino || initial.ctimeNs !== afterRealpath.ctimeNs) {
    fail("BOUND_PARENT_CHANGED");
  }
  emit({ phase: "ready", realPath, identity: serializeIdentity(afterRealpath) });
  const request = await readCommand();
  if (request.phase !== "execute") fail("BOUND_PROTOCOL_INVALID");
  const expectedParent = exactObject(request.expectedParent, ["dev", "ino"]);
  const beforeExecute = await fs.lstat(".", { bigint: true });
  if (!beforeExecute.isDirectory() || beforeExecute.dev !== bigintField(expectedParent.dev) ||
      beforeExecute.ino !== bigintField(expectedParent.ino)) {
    fail("BOUND_PARENT_CHANGED");
  }
  const result = await execute(request.command);
  const finalParent = await fs.lstat(".", { bigint: true });
  if (!finalParent.isDirectory() || finalParent.dev !== beforeExecute.dev || finalParent.ino !== beforeExecute.ino) {
    fail("BOUND_PARENT_CHANGED");
  }
  const responseMode = request.command && typeof request.command === "object" &&
    "responseMode" in request.command ? request.command.responseMode : null;
  if (responseMode === "pause_before_response") await new Promise(() => undefined);
  if (responseMode === "truncate_response") {
    await new Promise((resolve, reject) => {
      process.stdout.write('{"phase":"result"', (error) => error ? reject(error) : resolve());
    });
  } else {
    emit({
      phase: "result",
      ok: true,
      result,
      parentIdentity: serializeIdentity(finalParent),
      parentRealPath: await fs.realpath(".")
    });
  }
} catch (error) {
  emit({ phase: "result", ok: false, code: safeErrorCode(error) });
  process.exitCode = 1;
}
`;

export const PARENT_BOUND_FS_WORKER_SOURCE = [
  PARENT_BOUND_FS_WORKER_BOOTSTRAP_SOURCE,
  PARENT_BOUND_FS_WORKER_OPERATIONS_SOURCE,
  PARENT_BOUND_FS_WORKER_MAIN_SOURCE
].join("\n");
