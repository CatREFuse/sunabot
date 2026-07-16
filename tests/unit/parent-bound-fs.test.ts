// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parentBoundAtomicReplace,
  parentBoundCreateIfMissing,
  parentBoundExclusiveWrite,
  parentBoundMkdir,
  parentBoundRename,
  runParentBoundMutation
} from "../../adapters/filesystem/parentBoundFs.js";
import { PARENT_BOUND_FS_WORKER_OPERATIONS_SOURCE } from "../../adapters/filesystem/parentBoundFsWorkerOperationsSource.js";
import { PARENT_BOUND_FS_WORKER_SOURCE } from "../../adapters/filesystem/parentBoundFsWorkerSource.js";
import {
  acquireFileLock,
  pinDirectoryIdentity
} from "../../adapters/filesystem/agentExtensionSecureFs.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("parent-bound filesystem mutation", () => {
  it("composes one fixed Node eval source for native and Docker runtimes without template injection", () => {
    expect(PARENT_BOUND_FS_WORKER_SOURCE).toContain(PARENT_BOUND_FS_WORKER_OPERATIONS_SOURCE);
    expect(PARENT_BOUND_FS_WORKER_SOURCE.match(/async function recoverOperation\(/gu)).toHaveLength(1);
    expect(PARENT_BOUND_FS_WORKER_SOURCE.match(/async function finalizeOperation\(/gu)).toHaveLength(1);
    expect(PARENT_BOUND_FS_WORKER_SOURCE).toContain('import fs from "node:fs/promises";');
    expect(PARENT_BOUND_FS_WORKER_SOURCE).not.toContain("${");
    expect(PARENT_BOUND_FS_WORKER_OPERATIONS_SOURCE).not.toContain("${");
  });

  it.each(["mkdir", "write", "rename", "atomic-replace"])(
    "keeps the final %s syscall on the verified parent inode after the pathname becomes an outside symlink",
    async (operation) => {
      const parent = await privateDirectory();
      const outside = await privateDirectory();
      const moved = `${parent}-moved`;
      const sentinel = path.join(outside, "sentinel.txt");
      await fs.writeFile(sentinel, "unchanged\n");
      if (operation === "rename") {
        await fs.mkdir(path.join(parent, "source"), { mode: 0o700 });
      }
      if (operation === "atomic-replace") {
        await fs.writeFile(path.join(parent, "target.json"), "old\n", { mode: 0o600 });
      }
      const identity = await pinDirectoryIdentity(parent, parent);
      const swapAfterReady = async () => {
        await fs.rename(parent, moved);
        await fs.symlink(outside, parent);
      };
      try {
        if (operation === "mkdir") {
          await parentBoundMkdir({
            parent,
            parentIdentity: identity,
            name: "created",
            hook: { beforeCommand: swapAfterReady }
          });
          expect((await fs.lstat(path.join(moved, "created"))).isDirectory()).toBe(true);
        } else if (operation === "write") {
          await parentBoundExclusiveWrite({
            parent,
            parentIdentity: identity,
            name: "probe.txt",
            content: Buffer.from("bound\n"),
            hook: { beforeCommand: swapAfterReady }
          });
          expect(await fs.readFile(path.join(moved, "probe.txt"), "utf8")).toBe("bound\n");
        } else if (operation === "rename") {
          const source = path.join(parent, "source");
          await parentBoundRename({
            source,
            destination: path.join(parent, "destination"),
            parentIdentity: identity,
            expectedSource: await fs.lstat(source, { bigint: true }),
            hook: { beforeCommand: swapAfterReady }
          });
          expect((await fs.lstat(path.join(moved, "destination"))).isDirectory()).toBe(true);
          await expect(fs.access(path.join(moved, "source"))).rejects.toMatchObject({ code: "ENOENT" });
        } else {
          const target = path.join(parent, "target.json");
          const outcome = await parentBoundAtomicReplace({
            filePath: target,
            parentIdentity: identity,
            content: Buffer.from("new\n"),
            expectedTarget: await fs.lstat(target, { bigint: true }),
            hook: { beforeCommand: swapAfterReady }
          });
          expect(await fs.readFile(path.join(moved, "target.json"), "utf8")).toBe("new\n");
          expect(typeof outcome.result.quarantine).toBe("string");
          expect(await fs.readFile(path.join(moved, String(outcome.result.quarantine)), "utf8")).toBe("old\n");
        }
        expect(await fs.readFile(sentinel, "utf8")).toBe("unchanged\n");
        expect((await fs.readdir(outside)).sort()).toEqual(["sentinel.txt"]);
      } finally {
        const currentParent = await fs.lstat(parent).catch(() => null);
        if (currentParent?.isSymbolicLink()) await fs.unlink(parent);
        if (await fs.lstat(moved).then(() => true).catch(() => false)) await fs.rename(moved, parent);
      }
    }
  );

  it("bounds timeout cleanup and rejects untrusted path operands before spawning", async () => {
    const parent = await privateDirectory();
    const identity = await pinDirectoryIdentity(parent, parent);
    await expect(parentBoundMkdir({
      parent,
      parentIdentity: identity,
      name: "../outside"
    })).rejects.toMatchObject({ code: "BOUND_BASENAME_INVALID" });
    await expect(runParentBoundMutation({
      parent,
      parentIdentity: identity,
      command: { op: "sync" },
      timeoutMs: 100,
      hook: { beforeCommand: () => new Promise(() => undefined) }
    })).rejects.toMatchObject({ code: "BOUND_WORKER_TIMEOUT" });
  });

  it.each(["pause_before_response", "truncate_response"])(
    "does not swallow a mkdir response loss for %s and permits explicit state reconciliation",
    async (workerFailureMode) => {
      const parent = await privateDirectory();
      const identity = await pinDirectoryIdentity(parent, parent);
      await expect(parentBoundMkdir({
        parent,
        parentIdentity: identity,
        name: "created",
        workerFailureMode,
        workerTimeoutMs: 150
      })).rejects.toBeTruthy();
      const current = await pinDirectoryIdentity(parent, parent);
      const reconciled = await parentBoundMkdir({
        parent,
        parentIdentity: current,
        name: "created"
      });
      expect(reconciled.result.created).toBe(false);
    }
  );

  it("keeps the existing target intact and removes its private temporary when expected identity is stale", async () => {
    const parent = await privateDirectory();
    const target = path.join(parent, "target.json");
    await fs.writeFile(target, "old\n", { mode: 0o600 });
    const stale = await fs.lstat(target, { bigint: true });
    await fs.writeFile(target, "changed\n", { mode: 0o600 });
    const identity = await pinDirectoryIdentity(parent, parent);
    await expect(parentBoundAtomicReplace({
      filePath: target,
      parentIdentity: identity,
      content: Buffer.from("new\n"),
      expectedTarget: stale
    })).rejects.toMatchObject({ code: "BOUND_SOURCE_CHANGED" });
    expect(await fs.readFile(target, "utf8")).toBe("changed\n");
    expect(await fs.readdir(parent)).toEqual(["target.json"]);
  });

  it.each([
    "after_target_rename",
    "after_target_verify",
    "after_evidence_verify",
    "after_fsync",
    "before_response"
  ])("reconciles atomic replace fault %s to the old inode", async (faultAt) => {
    const parent = await privateDirectory();
    const target = path.join(parent, "target.json");
    await fs.writeFile(target, "old\n", { mode: 0o600 });
    const old = await fs.lstat(target, { bigint: true });
    const identity = await pinDirectoryIdentity(parent, parent);
    await expect(parentBoundAtomicReplace({
      filePath: target,
      parentIdentity: identity,
      content: Buffer.from("new\n"),
      expectedTarget: old,
      faultAt
    } as Parameters<typeof parentBoundAtomicReplace>[0])).rejects.toBeTruthy();
    const restored = await fs.lstat(target, { bigint: true });
    expect({ dev: restored.dev, ino: restored.ino }).toEqual({ dev: old.dev, ino: old.ino });
    expect(await fs.readFile(target, "utf8")).toBe("old\n");
  });

  it.each(["pause_before_response", "truncate_response"])(
    "uses persistent intent to recover existing atomic target after real worker %s",
    async (workerFailureMode) => {
      const parent = await privateDirectory();
      const target = path.join(parent, "target.json");
      await fs.writeFile(target, "old\n", { mode: 0o600 });
      const old = await fs.lstat(target, { bigint: true });
      const identity = await pinDirectoryIdentity(parent, parent);
      await expect(parentBoundAtomicReplace({
        filePath: target,
        parentIdentity: identity,
        content: Buffer.from("new\n"),
        expectedTarget: old,
        workerFailureMode,
        workerTimeoutMs: 150
      } as Parameters<typeof parentBoundAtomicReplace>[0])).rejects.toBeTruthy();
      const restored = await fs.lstat(target, { bigint: true });
      expect({ dev: restored.dev, ino: restored.ino }).toEqual({ dev: old.dev, ino: old.ino });
      expect(await fs.readFile(target, "utf8")).toBe("old\n");
      expect(await fs.readdir(parent)).toEqual(["target.json"]);
    }
  );

  it.each(["pause_before_response", "truncate_response"])(
    "uses persistent intent to recover absent atomic target after real worker %s",
    async (workerFailureMode) => {
      const parent = await privateDirectory();
      const target = path.join(parent, "target.json");
      const identity = await pinDirectoryIdentity(parent, parent);
      await expect(parentBoundAtomicReplace({
        filePath: target,
        parentIdentity: identity,
        content: Buffer.from("new\n"),
        expectedTarget: null,
        workerFailureMode,
        workerTimeoutMs: 150
      } as Parameters<typeof parentBoundAtomicReplace>[0])).rejects.toBeTruthy();
      await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(parent)).toEqual([]);
    }
  );

  it.each(["pause_before_response", "truncate_response"])(
    "proves the committed target after finalize worker %s before returning success",
    async (finalizeWorkerFailureMode) => {
      const parent = await privateDirectory();
      const target = path.join(parent, "target.json");
      await fs.writeFile(target, "old\n", { mode: 0o600 });
      const old = await fs.lstat(target, { bigint: true });
      const identity = await pinDirectoryIdentity(parent, parent);
      const outcome = await parentBoundAtomicReplace({
        filePath: target,
        parentIdentity: identity,
        content: Buffer.from("new\n"),
        expectedTarget: old,
        finalizeWorkerFailureMode,
        workerTimeoutMs: 150
      });
      expect(await fs.readFile(target, "utf8")).toBe("new\n");
      expect(await fs.readFile(path.join(parent, String(outcome.result.quarantine)), "utf8")).toBe("old\n");
      expect((await fs.readdir(parent)).sort()).toEqual([
        String(outcome.result.quarantine),
        "target.json"
      ].sort());
    }
  );

  it("recovers create-if-missing when the real worker is killed after link and removes the nlink=2 residue", async () => {
    const parent = await privateDirectory();
    const target = path.join(parent, "index.json");
    const identity = await pinDirectoryIdentity(parent, parent);
    await expect(parentBoundCreateIfMissing({
      filePath: target,
      parentIdentity: identity,
      content: Buffer.from("{}\n"),
      workerFailureMode: "pause_after_link",
      workerTimeoutMs: 150
    } as Parameters<typeof parentBoundCreateIfMissing>[0])).rejects.toBeTruthy();
    await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it.each(["after_target_rename", "after_fsync", "before_response"])(
    "reconciles create-style atomic fault %s to an absent target",
    async (faultAt) => {
      const parent = await privateDirectory();
      const target = path.join(parent, "target.json");
      const identity = await pinDirectoryIdentity(parent, parent);
      await expect(parentBoundAtomicReplace({
        filePath: target,
        parentIdentity: identity,
        content: Buffer.from("new\n"),
        expectedTarget: null,
        faultAt
      } as Parameters<typeof parentBoundAtomicReplace>[0])).rejects.toBeTruthy();
      await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("reports recovery-required when create-if-missing cannot complete its post-link cleanup", async () => {
    const parent = await privateDirectory();
    const identity = await pinDirectoryIdentity(parent, parent);
    await expect(parentBoundCreateIfMissing({
      filePath: path.join(parent, "index.json"),
      parentIdentity: identity,
      content: Buffer.from("{}\n"),
      faultAt: "cleanup_failure"
    } as Parameters<typeof parentBoundCreateIfMissing>[0])).rejects.toMatchObject({
      code: "BOUND_RECOVERY_REQUIRED"
    });
  });

  it("reports recovery-required instead of accepting an unverified atomic rollback", async () => {
    const parent = await privateDirectory();
    const target = path.join(parent, "target.json");
    await fs.writeFile(target, "old\n", { mode: 0o600 });
    const identity = await pinDirectoryIdentity(parent, parent);
    await expect(parentBoundAtomicReplace({
      filePath: target,
      parentIdentity: identity,
      content: Buffer.from("new\n"),
      expectedTarget: await fs.lstat(target, { bigint: true }),
      faultAt: "recovery_failure"
    })).rejects.toMatchObject({ code: "BOUND_RECOVERY_REQUIRED" });
  });

  it("reconciles an exclusive lock whose successful worker response is lost", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const lock = await acquireFileLock(lockPath, { faultAt: "before_response" } as never);
    expect(await fs.readFile(lockPath, "utf8")).toMatch(/^[1-9][0-9]*:[0-9a-f-]{36}\n$/u);
    await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ code: "AGENT_EXTENSION_BUSY" });
    await lock.close();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["pause_before_response", "truncate_response"])(
    "reconciles an exclusive lock by its owner token after real worker %s",
    async (workerFailureMode) => {
      const parent = await privateDirectory();
      const lockPath = path.join(parent, ".index.lock");
      const lock = await acquireFileLock(lockPath, {
        workerFailureMode,
        workerTimeoutMs: 150
      });
      expect(await fs.readFile(lockPath, "utf8")).toMatch(/^[1-9][0-9]*:[0-9a-f-]{36}\n$/u);
      await lock.close();
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("accepts NFC Unicode resource names while rejecting decomposed and control basenames", async () => {
    const parent = await privateDirectory();
    const identity = await pinDirectoryIdentity(parent, parent);
    await parentBoundExclusiveWrite({
      parent,
      parentIdentity: identity,
      name: "说明-猫.txt",
      content: Buffer.from("ok\n")
    });
    expect(await fs.readFile(path.join(parent, "说明-猫.txt"), "utf8")).toBe("ok\n");
    await expect(parentBoundMkdir({
      parent,
      parentIdentity: identity,
      name: "e\u0301"
    })).rejects.toMatchObject({ code: "BOUND_BASENAME_INVALID" });
    await expect(parentBoundMkdir({
      parent,
      parentIdentity: identity,
      name: "bad\nname"
    })).rejects.toMatchObject({ code: "BOUND_BASENAME_INVALID" });
  });
});

async function privateDirectory() {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-parent-bound-"));
  temporaryDirectories.push(created);
  await fs.chmod(created, 0o700);
  return fs.realpath(created);
}
