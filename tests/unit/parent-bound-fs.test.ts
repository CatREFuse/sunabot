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
  parentBoundReleaseLock,
  parentBoundRename,
  parentBoundUnlink,
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

  it.each(["mkdir", "write", "rename", "atomic-replace", "unlink"])(
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
      if (operation === "unlink") {
        await fs.writeFile(path.join(parent, "target.json"), "remove\n", { mode: 0o600 });
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
        } else if (operation === "atomic-replace") {
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
        } else {
          const target = path.join(parent, "target.json");
          await parentBoundUnlink({
            filePath: target,
            parentIdentity: identity,
            expectedTarget: await fs.lstat(target, { bigint: true }),
            hook: { beforeCommand: swapAfterReady }
          });
          await expect(fs.access(path.join(moved, "target.json"))).rejects.toMatchObject({ code: "ENOENT" });
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
        workerTimeoutMs: 2_000
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
        workerTimeoutMs: 2_000
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
        workerTimeoutMs: 2_000
      } as Parameters<typeof parentBoundAtomicReplace>[0])).rejects.toBeTruthy();
      await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(parent)).toEqual([]);
    }
  );

  it.each([
    { finalizeWorkerFailureMode: "pause_before_response", workerTimeoutMs: 2_000 },
    { finalizeWorkerFailureMode: "truncate_response", workerTimeoutMs: 2_000 }
  ])(
    "proves the committed target after finalize worker $finalizeWorkerFailureMode before returning success",
    async ({ finalizeWorkerFailureMode, workerTimeoutMs }) => {
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
        workerTimeoutMs
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
      workerTimeoutMs: 2_000
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
    let releaseWorkers = 0;
    const lock = await acquireFileLock(lockPath, {
      faultAt: "before_response",
      beforeReleaseWorker() { releaseWorkers += 1; }
    });
    expect(await fs.readFile(lockPath, "utf8")).toMatch(/^[1-9][0-9]*:[0-9a-f-]{36}\n$/u);
    await expect(acquireFileLock(lockPath)).rejects.toMatchObject({ code: "AGENT_EXTENSION_BUSY" });
    await lock.close();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lockTombstones(parent)).toEqual([]);
    expect(releaseWorkers).toBe(1);
  });

  it("allows independent sibling locks to be acquired and released concurrently", async () => {
    const parent = await privateDirectory();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [indexLock, copyLock] = await Promise.all([
        acquireFileLock(path.join(parent, ".index.lock")),
        acquireFileLock(path.join(parent, ".copy.lock"))
      ]);
      await Promise.all([indexLock.close(), copyLock.close()]);
      await expect(fs.access(path.join(parent, ".index.lock")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(parent, ".copy.lock")))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await lockTombstones(parent)).toEqual([]);
    }
  });

  it("keeps lock mutations bound to the same parent when sibling entries change its ctime", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const tombstone = path.join(parent, ".extension-lock-tombstone-test");
    const acquireIdentity = await pinDirectoryIdentity(parent, parent);
    await fs.writeFile(path.join(parent, ".copy.lock"), "sibling\n", { mode: 0o600 });

    await parentBoundExclusiveWrite({
      parent,
      parentIdentity: acquireIdentity,
      name: path.basename(lockPath),
      content: Buffer.from("owner\n"),
      allowParentCtimeChange: true
    });

    const releaseIdentity = await pinDirectoryIdentity(parent, parent);
    const lockIdentity = await fs.lstat(lockPath, { bigint: true });
    await fs.writeFile(path.join(parent, ".runtime.lock"), "sibling\n", { mode: 0o600 });
    await parentBoundReleaseLock({
      source: lockPath,
      tombstone,
      parentIdentity: releaseIdentity,
      expectedSource: lockIdentity,
      allowParentCtimeChange: true
    });

    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(tombstone)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["pause_before_response", "truncate_response"])(
    "reconciles an exclusive lock by its owner token after real worker %s",
    async (workerFailureMode) => {
      const parent = await privateDirectory();
      const lockPath = path.join(parent, ".index.lock");
      const lock = await acquireFileLock(lockPath, {
        workerFailureMode,
        workerTimeoutMs: 2_000
      });
      expect(await fs.readFile(lockPath, "utf8")).toMatch(/^[1-9][0-9]*:[0-9a-f-]{36}\n$/u);
      await lock.close();
      await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await lockTombstones(parent)).toEqual([]);
    }
  );

  it.each([
    ["worker response loss", { releaseWorkerFailureMode: "truncate_response" as const }],
    ["after unlink fault", { releaseFaultAt: "after_unlink_before_response" as const }],
    ["after rename fault", { releaseFaultAt: "after_rename_before_unlink" as const }]
  ])("reconciles lock %s without retaining a tombstone", async (_stage, releaseOptions) => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const lock = await acquireFileLock(lockPath, {
      ...releaseOptions,
      releaseWorkerTimeoutMs: 2_000
    });

    await lock.close();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await lockTombstones(parent)).toEqual([]);
  });

  it("repairs the two-link reservation after a release worker is killed before source unlink", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const lock = await acquireFileLock(lockPath, {
      releasePauseAt: "after_link_before_source_unlink",
      releaseWorkerTimeoutMs: 2_000
    });
    const original = await fs.lstat(lockPath, { bigint: true });

    const closeError = await lock.close().then(
      () => undefined,
      (error: unknown) => error
    );
    expect(closeError).toBeInstanceOf(Error);
    expect(["BOUND_WORKER_TIMEOUT", "BOUND_WORKER_FAILED"]).toContain(
      (closeError as NodeJS.ErrnoException).code
    );
    const restored = await fs.lstat(lockPath, { bigint: true });
    expect(restored.dev).toBe(original.dev);
    expect(restored.ino).toBe(original.ino);
    expect(restored.size).toBe(original.size);
    expect(restored.mtimeNs).toBe(original.mtimeNs);
    expect(restored.mode).toBe(original.mode);
    expect(restored.nlink).toBe(1n);
    expect(restored.ctimeNs).not.toBe(original.ctimeNs);
    expect(await lockTombstones(parent)).toEqual([]);
    await lock.close();
    await expect(fs.access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("repairs a restarted two-link reservation before reclaiming a dead process lock", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const tombstone = path.join(parent, ".extension-lock-tombstone-00000000-0000-4000-8000-000000000002");
    await fs.writeFile(lockPath, "2147483647:00000000-0000-4000-8000-000000000002\n", { mode: 0o600 });
    await fs.link(lockPath, tombstone);
    expect((await fs.lstat(lockPath)).nlink).toBe(2);

    const lock = await acquireFileLock(lockPath);
    expect((await fs.lstat(lockPath)).nlink).toBe(1);
    expect(await lockTombstones(parent)).toEqual([]);
    await lock.close();
  });

  it.each(["different-inodes", "different-content", "extra-link"])(
    "fails closed on an invalid two-link reservation with %s",
    async (kind) => {
      const parent = await privateDirectory();
      const lockPath = path.join(parent, ".index.lock");
      const tombstone = path.join(
        parent,
        ".extension-lock-tombstone-00000000-0000-4000-8000-000000000003"
      );
      const token = "2147483647:00000000-0000-4000-8000-000000000003\n";
      await fs.writeFile(lockPath, token, { mode: 0o600 });
      if (kind === "different-inodes" || kind === "different-content") {
        const tombstoneToken = kind === "different-content"
          ? "2147483647:00000000-0000-4000-8000-000000000004\n"
          : token;
        await fs.writeFile(tombstone, tombstoneToken, { mode: 0o600 });
        await fs.link(lockPath, path.join(parent, "source-extra-link"));
        await fs.link(tombstone, path.join(parent, "tombstone-extra-link"));
      } else {
        await fs.link(lockPath, tombstone);
        await fs.link(lockPath, path.join(parent, "third-link"));
      }

      const acquireError = await acquireFileLock(lockPath).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(acquireError).toBeInstanceOf(Error);
      expect(["AGENT_EXTENSION_PATH_CHANGED", "AGENT_EXTENSION_PATH_INVALID"]).toContain(
        (acquireError as NodeJS.ErrnoException).code
      );
      await expect(fs.lstat(lockPath)).resolves.toBeDefined();
    }
  );

  it("fails closed when the parent is replaced while repairing a two-link reservation", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const tombstone = path.join(parent, ".extension-lock-tombstone-00000000-0000-4000-8000-000000000005");
    const movedParent = `${parent}-moved`;
    temporaryDirectories.push(movedParent);
    await fs.writeFile(lockPath, "2147483647:00000000-0000-4000-8000-000000000005\n", { mode: 0o600 });
    await fs.link(lockPath, tombstone);

    await expect(acquireFileLock(lockPath, {
      async beforeTombstoneRead() {
        await fs.rename(parent, movedParent);
        await fs.mkdir(parent, { mode: 0o700 });
      }
    })).rejects.toMatchObject({ code: "AGENT_EXTENSION_PATH_CHANGED" });
    expect(await fs.readdir(parent)).toEqual([]);
    expect((await fs.lstat(path.join(movedParent, ".index.lock"))).nlink).toBe(2);
  });

  it("retries failed tombstone cleanup and garbage collects it before the next lock", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    let failCleanup = true;
    const lock = await acquireFileLock(lockPath, {
      releaseFaultAt: "after_rename_before_unlink",
      beforeReleaseFallbackUnlink() {
        if (failCleanup) throw new Error("injected cleanup failure");
      }
    });

    await expect(lock.close()).rejects.toThrow("injected cleanup failure");
    expect(await lockTombstones(parent)).toHaveLength(1);
    failCleanup = false;
    const next = await acquireFileLock(lockPath);
    expect(await lockTombstones(parent)).toEqual([]);
    await lock.close();
    await next.close();
    expect(await lockTombstones(parent)).toEqual([]);
  });

  it("converges when close and the next acquire race to clean the same tombstone", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    let enterCleanup!: () => void;
    let continueCleanup!: () => void;
    const cleanupEntered = new Promise<void>((resolve) => { enterCleanup = resolve; });
    const cleanupReleased = new Promise<void>((resolve) => { continueCleanup = resolve; });
    const lock = await acquireFileLock(lockPath, {
      releaseFaultAt: "after_rename_before_unlink",
      async beforeReleaseFallbackUnlink() {
        enterCleanup();
        await cleanupReleased;
      }
    });

    const closing = lock.close();
    await cleanupEntered;
    const next = await acquireFileLock(lockPath);
    continueCleanup();
    await closing;
    expect(await lockTombstones(parent)).toEqual([]);
    await next.close();
    expect(await lockTombstones(parent)).toEqual([]);
  });

  it("converges when another cleaner removes a tombstone immediately before its bounded read", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const lock = await acquireFileLock(lockPath, {
      releaseFaultAt: "after_rename_before_unlink",
      beforeReleaseFallbackUnlink() {
        throw new Error("leave tombstone for read race");
      }
    });
    await expect(lock.close()).rejects.toThrow("leave tombstone for read race");
    const [tombstone] = await lockTombstones(parent);
    expect(tombstone).toBeDefined();
    let removed = false;

    const next = await acquireFileLock(lockPath, {
      async beforeTombstoneRead(filePath) {
        if (removed) return;
        removed = true;
        expect(path.basename(filePath)).toBe(tombstone);
        await fs.unlink(filePath);
      }
    });

    expect(removed).toBe(true);
    expect(await lockTombstones(parent)).toEqual([]);
    await next.close();
  });

  it("rejects a parent replacement while reconciling a tombstone that disappears before read", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const lock = await acquireFileLock(lockPath, {
      releaseFaultAt: "after_rename_before_unlink",
      beforeReleaseFallbackUnlink() {
        throw new Error("leave tombstone for parent replacement");
      }
    });
    await expect(lock.close()).rejects.toThrow("leave tombstone for parent replacement");
    const movedParent = `${parent}-moved`;
    temporaryDirectories.push(movedParent);

    await expect(acquireFileLock(lockPath, {
      async beforeTombstoneRead(filePath) {
        await fs.unlink(filePath);
        await fs.rename(parent, movedParent);
        await fs.mkdir(parent, { mode: 0o700 });
      }
    })).rejects.toMatchObject({ code: "AGENT_EXTENSION_PATH_CHANGED" });
  });

  it("rejects a canonical lock replacement before the release worker executes", async () => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const displaced = path.join(parent, "displaced.lock");
    const lock = await acquireFileLock(lockPath, {
      async beforeReleaseWorker() {
        await fs.rename(lockPath, displaced);
        await fs.writeFile(lockPath, `${process.pid}:00000000-0000-4000-8000-000000000001\n`, { mode: 0o600 });
      }
    });

    await expect(lock.close()).rejects.toMatchObject({ code: "AGENT_EXTENSION_PATH_CHANGED" });
    expect(await fs.readFile(lockPath, "utf8")).toContain("00000000-0000-4000-8000-000000000001");
  });

  it.each(["symlink", "wide-mode"])("fails closed on a malicious lock tombstone %s", async (kind) => {
    const parent = await privateDirectory();
    const lockPath = path.join(parent, ".index.lock");
    const tombstone = path.join(parent, ".extension-lock-tombstone-00000000-0000-4000-8000-000000000001");
    if (kind === "symlink") {
      const target = path.join(parent, "target.txt");
      await fs.writeFile(target, `${process.pid}:00000000-0000-4000-8000-000000000001\n`, { mode: 0o600 });
      await fs.symlink(target, tombstone);
    } else {
      await fs.writeFile(tombstone, `${process.pid}:00000000-0000-4000-8000-000000000001\n`, { mode: 0o644 });
      await fs.chmod(tombstone, 0o644);
    }

    await expect(acquireFileLock(lockPath)).rejects.toMatchObject({
      code: "AGENT_EXTENSION_PATH_INVALID"
    });
    await expect(fs.lstat(tombstone)).resolves.toBeDefined();
  });

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

async function lockTombstones(parent: string) {
  return (await fs.readdir(parent)).filter((entry) => entry.startsWith(".extension-lock-tombstone-"));
}
