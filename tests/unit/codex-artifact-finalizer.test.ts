// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  chatMediaPublisher,
  createChatMediaPublisher
} from "../../adapters/filesystem/chatMediaPublisher.js";
import type {
  CodexRunner,
  CodexToolResult
} from "../../packages/contracts/tools/codex.js";
import { CacheStore } from "../../services/media/attachments/cache.js";
import type {
  CodexCoordinatorSettings,
  SessionClaimState
} from "../../services/sessions/sessionCoordinatorTypes.js";
import { SessionStore, type ToolJobRecord } from "../../services/sessions/sessionStore.js";
import { SessionToolJobProcessor } from "../../services/sessions/sessionToolJobProcessor.js";
import {
  finalizeCodexResultArtifacts,
  stageCodexResultArtifacts
} from "../../src/runtime/codexArtifacts.js";
import { testTempRoot } from "./test-temp-root.js";

const TEST_ROOT = testTempRoot("codex-artifact-finalizer");
const cleanupRoots: string[] = [];

afterAll(async () => {
  await Promise.all(cleanupRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true
  })));
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("Codex artifact finalizer", () => {
  it.each(["native", "docker"] as const)(
    "revalidates and publishes a runner artifact into the frozen %s Workbench",
    async (backend) => {
      const fixture = await artifactFixture(backend);

      const finalized = await finalizeCodexResultArtifacts({
        job: fixture.job,
        settings: fixture.settings,
        result: fixture.result,
        signal: new AbortController().signal,
        cache: fixture.cache
      });

      const [artifact] = finalized.artifacts ?? [];
      expect(artifact).toEqual({
        schemaVersion: 1,
        relativePath: `${publicationPrefix(fixture.job)}-${fixture.sha256}.txt`,
        displayName: "codex-result.txt",
        sha256: fixture.sha256,
        sizeBytes: fixture.bytes.byteLength,
        mimeType: "text/plain",
        handle: `codex:${fixture.job.id}:artifact:0`,
        backend
      });
      expect(finalized.resultFile).toBeUndefined();
      expect(finalized.content).not.toContain(fixture.jobDir);
      expect(artifact?.relativePath).not.toContain(fixture.jobDir);
      await expect(fs.readFile(path.join(
        fixture.settings.workspacePath,
        backend === "native" ? "workbench" : "docker-workbench",
        artifact!.relativePath
      ))).resolves.toEqual(fixture.bytes);
    }
  );

  it("rejects a symbolic-link artifact before Workbench publication", async () => {
    const fixture = await artifactFixture("native");
    const outsidePath = path.join(fixture.jobDir, "outside.txt");
    await fs.writeFile(outsidePath, fixture.bytes);
    await fs.unlink(fixture.sourcePath);
    await fs.symlink(outsidePath, fixture.sourcePath);

    await expect(finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    })).rejects.toMatchObject({ code: "codex_artifact_source_unsafe" });
    await expect(fs.access(path.join(
      fixture.settings.workspacePath,
      "workbench",
      `${publicationPrefix(fixture.job)}-${fixture.sha256}.txt`
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects content changed after the runner declaration", async () => {
    const fixture = await artifactFixture("native");
    await fs.writeFile(fixture.sourcePath, "changed artifact\n");

    await expect(finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    })).rejects.toMatchObject({ code: "codex_artifact_source_changed" });
  });

  it("publishes a bounded non-Office ZIP artifact without widening normal chat export", async () => {
    const fixture = await artifactFixture("docker");
    const zip = new JSZip();
    zip.file("result.txt", "bounded ZIP artifact\n");
    const bytes = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE"
    });
    const sourcePath = path.join(path.dirname(fixture.sourcePath), "codex-result.zip");
    await fs.unlink(fixture.sourcePath);
    await fs.writeFile(sourcePath, bytes);
    fixture.result.artifacts = [{
      schemaVersion: 1,
      relativePath: path.relative(fixture.jobDir, sourcePath),
      displayName: "codex-result.zip",
      sha256: digest(bytes),
      sizeBytes: bytes.byteLength,
      mimeType: "application/zip"
    }];

    const finalized = await finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    });

    const [artifact] = finalized.artifacts ?? [];
    expect(artifact).toMatchObject({
      relativePath: `${publicationPrefix(fixture.job)}-${digest(bytes)}.zip`,
      displayName: "codex-result.zip",
      mimeType: "application/zip",
      backend: "docker"
    });
    await expect(fs.readFile(path.join(
      fixture.settings.workspacePath,
      "docker-workbench",
      artifact!.relativePath
    ))).resolves.toEqual(bytes);
  });

  it("rolls back newly published files when a later artifact publication fails", async () => {
    const fixture = await artifactFixture("native");
    const secondBytes = Buffer.from("SECOND-CODEX-ARTIFACT\n", "utf8");
    const secondSha256 = digest(secondBytes);
    const secondSource = path.join(path.dirname(fixture.sourcePath), "second.txt");
    await fs.writeFile(secondSource, secondBytes);
    fixture.result.artifacts!.push({
      schemaVersion: 1,
      relativePath: path.relative(fixture.jobDir, secondSource),
      displayName: "second.txt",
      sha256: secondSha256,
      sizeBytes: secondBytes.byteLength,
      mimeType: "text/plain"
    });
    let publishCalls = 0;

    await expect(finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache,
      publisher: {
        async publish(input) {
          publishCalls += 1;
          if (publishCalls === 2) throw new Error("injected second publish failure");
          return chatMediaPublisher.publish(input);
        }
      }
    })).rejects.toThrow("CHAT_MEDIA_EXPORT_FAILED");

    await expect(fs.access(path.join(
      fixture.settings.workspacePath,
      "workbench",
      `${publicationPrefix(fixture.job)}-${fixture.sha256}.txt`
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects declarations outside the exact attempt output directory", async () => {
    const fixture = await artifactFixture("native");
    const secretPath = path.join(
      fixture.jobDir,
      ".codex-worker",
      "attempt-1-attempt-token",
      "codex-home",
      "auth.json"
    );
    const secretBytes = Buffer.from('{"token":"must-not-export"}\n', "utf8");
    await fs.mkdir(path.dirname(secretPath), { recursive: true });
    await fs.writeFile(secretPath, secretBytes);
    fixture.result.artifacts = [{
      schemaVersion: 1,
      relativePath: path.relative(fixture.jobDir, secretPath),
      displayName: "auth.json",
      sha256: digest(secretBytes),
      sizeBytes: secretBytes.byteLength,
      mimeType: "application/json"
    }];

    await expect(finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    })).rejects.toMatchObject({ code: "codex_artifact_path_invalid" });
  });

  it("rejects an artifact declared from a different durable attempt", async () => {
    const fixture = await artifactFixture("native");
    const stalePath = path.join(
      fixture.jobDir,
      ".codex-worker",
      "attempt-2-stale-token",
      "outputs",
      "stale.txt"
    );
    await fs.mkdir(path.dirname(stalePath), { recursive: true });
    await fs.writeFile(stalePath, fixture.bytes);
    fixture.result.artifacts = [{
      ...fixture.result.artifacts![0]!,
      relativePath: path.relative(fixture.jobDir, stalePath)
    }];

    await expect(finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    })).rejects.toMatchObject({ code: "codex_artifact_path_invalid" });
  });

  it("downgrades an unverified forged file type to octet-stream and .bin", async () => {
    const fixture = await artifactFixture("native");
    const forgedBytes = Buffer.from(Array.from({ length: 16 }, (_, index) => index));
    await fs.unlink(fixture.sourcePath);
    const forgedPath = path.join(path.dirname(fixture.sourcePath), "forged.pdf");
    await fs.writeFile(forgedPath, forgedBytes);
    fixture.result.artifacts = [{
      schemaVersion: 1,
      relativePath: path.relative(fixture.jobDir, forgedPath),
      displayName: "forged.pdf",
      sha256: digest(forgedBytes),
      sizeBytes: forgedBytes.byteLength,
      mimeType: "application/pdf"
    }];

    const finalized = await finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    });

    expect(finalized.artifacts?.[0]).toMatchObject({
      relativePath: `${publicationPrefix(fixture.job)}-${digest(forgedBytes)}.bin`,
      mimeType: "application/octet-stream"
    });
  });

  it("rolls back a staged artifact when the durable claim cannot commit", async () => {
    const fixture = await artifactFixture("native");
    const staged = await stageCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    });
    const artifactPath = path.join(
      fixture.settings.workspacePath,
      "workbench",
      staged.result.artifacts![0]!.relativePath
    );
    await expect(fs.access(artifactPath)).resolves.toBeUndefined();

    await staged.rollback();

    await expect(fs.access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a committed rename with a lost response and keeps rollback ownership", async () => {
    const fixture = await artifactFixture("native");
    const staged = await stageCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache,
      publisher: createChatMediaPublisher({
        renameFaultAt: "after_rename_before_response"
      })
    });
    const artifactPath = path.join(
      fixture.settings.workspacePath,
      "workbench",
      staged.result.artifacts![0]!.relativePath
    );
    await expect(fs.access(artifactPath)).resolves.toBeUndefined();

    await staged.rollback();

    await expect(fs.access(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not let an old attempt rollback remove a newer committed attempt", async () => {
    const fixture = await artifactFixture("native");
    const oldStage = await stageCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    });
    const newerJob: ToolJobRecord = {
      ...fixture.job,
      attempts: 2,
      attemptToken: "newer-attempt-token"
    };
    const newerOutput = path.join(
      fixture.jobDir,
      ".codex-worker",
      "attempt-2-newer-attempt-token",
      "outputs",
      "codex-result.txt"
    );
    await fs.mkdir(path.dirname(newerOutput), { recursive: true });
    await fs.writeFile(newerOutput, fixture.bytes);
    const newerResult: CodexToolResult = {
      ...fixture.result,
      artifacts: [{
        ...fixture.result.artifacts![0]!,
        relativePath: path.relative(fixture.jobDir, newerOutput)
      }]
    };
    const newerStage = await stageCodexResultArtifacts({
      job: newerJob,
      settings: fixture.settings,
      result: newerResult,
      signal: new AbortController().signal,
      cache: fixture.cache
    });
    newerStage.commit();
    const newerArtifactPath = path.join(
      fixture.settings.workspacePath,
      "workbench",
      newerStage.result.artifacts![0]!.relativePath
    );

    await oldStage.rollback();

    await expect(fs.readFile(newerArtifactPath)).resolves.toEqual(fixture.bytes);
    expect(newerStage.result.artifacts![0]!.relativePath)
      .not.toBe(oldStage.result.artifacts![0]!.relativePath);
  });

  it("removes a just-published artifact when cancellation arrives inside publication", async () => {
    const fixture = await artifactFixture("native");
    const controller = new AbortController();

    await expect(stageCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: controller.signal,
      cache: fixture.cache,
      publisher: {
        async publish(input) {
          const result = await chatMediaPublisher.publish(input);
          controller.abort(new Error("claim expired"));
          return result;
        }
      }
    })).rejects.toThrow("claim expired");

    await expect(fs.access(path.join(
      fixture.settings.workspacePath,
      "workbench",
      `${publicationPrefix(fixture.job)}-${fixture.sha256}.txt`
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("redacts both job and workspace paths from non-success results", async () => {
    const fixture = await artifactFixture("native");
    fixture.settings.authFile = path.join(fixture.root, "secrets", "codex", "auth.json");
    fixture.settings.executable = path.join(fixture.root, "bin", "codex");
    const exposed = [
      fixture.jobDir,
      fixture.settings.workspacePath,
      fixture.settings.authFile,
      fixture.settings.executable
    ].join(" ");
    const finalized = await finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: {
        ok: false,
        status: "failed",
        jobId: fixture.job.id,
        kind: "local",
        content: exposed,
        stderr: exposed,
        question: exposed,
        error: { code: "worker_failed", message: exposed }
      },
      signal: new AbortController().signal,
      cache: fixture.cache
    });

    expect(JSON.stringify(finalized)).not.toContain(fixture.jobDir);
    expect(JSON.stringify(finalized)).not.toContain(fixture.settings.workspacePath);
    expect(JSON.stringify(finalized)).not.toContain(fixture.settings.authFile);
    expect(JSON.stringify(finalized)).not.toContain(fixture.settings.executable);
  });

  it("keeps a legacy result with no artifact declarations", async () => {
    const fixture = await artifactFixture("native");
    delete (fixture.job.arguments as Record<string, unknown>).__sunabot_artifact_backend;
    delete fixture.result.artifacts;

    const finalized = await finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    });

    expect(finalized).toMatchObject({
      ok: true,
      status: "succeeded",
      content: expect.any(String)
    });
    expect(finalized.artifacts).toBeUndefined();
  });

  it("fails a job with new artifacts when no backend was frozen", async () => {
    const fixture = await artifactFixture("native");
    delete (fixture.job.arguments as Record<string, unknown>).__sunabot_artifact_backend;

    await expect(finalizeCodexResultArtifacts({
      job: fixture.job,
      settings: fixture.settings,
      result: fixture.result,
      signal: new AbortController().signal,
      cache: fixture.cache
    })).rejects.toMatchObject({ code: "codex_artifact_backend_missing" });
    await expect(fs.access(path.join(
      fixture.settings.workspacePath,
      "workbench",
      `${publicationPrefix(fixture.job)}-${fixture.sha256}.txt`
    ))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("SessionToolJobProcessor artifact finalization", () => {
  it("waits for finalization before durable completion", async () => {
    const store = new SessionStore({ databasePath: ":memory:" });
    const job = claimCodexJob(store);
    const release = deferred<void>();
    const entered = deferred<void>();
    const runnerResult = codexResult(job.id);
    const processor = processorFixture(store, {
      async run() {
        return runnerResult;
      }
    }, async ({ result }) => {
      expect(store.getToolJob(job.id)?.status).toBe("running");
      entered.resolve();
      await release.promise;
      return stagedResult({
        ...result,
        artifacts: [{
          schemaVersion: 1,
          relativePath: "chat-media-safe.txt",
          displayName: "safe.txt",
          sha256: "a".repeat(64),
          sizeBytes: 4,
          mimeType: "text/plain",
          handle: `codex:${job.id}:artifact:0`,
          backend: "native"
        }]
      });
    });

    const processing = processor.processor.process(
      { job, settings: processor.settings, state: processor.state },
      new AbortController().signal
    );
    await entered.promise;
    expect(store.getToolJob(job.id)?.status).toBe("running");
    release.resolve();
    await processing;

    expect(store.getToolJob(job.id)).toMatchObject({
      status: "succeeded",
      result: {
        artifacts: [{
          relativePath: "chat-media-safe.txt",
          handle: `codex:${job.id}:artifact:0`,
          backend: "native"
        }]
      }
    });
    store.close();
  });

  it("fails the durable job when artifact finalization fails", async () => {
    const store = new SessionStore({ databasePath: ":memory:" });
    const job = claimCodexJob(store);
    const completeSpy = vi.spyOn(store, "completeToolJob");
    const processor = processorFixture(store, {
      async run() {
        return codexResult(job.id);
      }
    }, async () => {
      throw Object.assign(new Error("artifact changed"), {
        code: "codex_artifact_source_changed"
      });
    });

    await processor.processor.process(
      { job, settings: processor.settings, state: processor.state },
      new AbortController().signal
    );

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(store.getToolJob(job.id)).toMatchObject({
      status: "failed",
      error: {
        code: "codex_artifact_source_changed",
        message: "artifact changed"
      }
    });
    store.close();
  });

  it("rolls back staged publication when the claim expires before durable completion", async () => {
    const store = new SessionStore({ databasePath: ":memory:" });
    const job = claimCodexJob(store);
    const rollback = vi.fn(async () => undefined);
    let claimChecks = 0;
    const processor = processorFixture(store, {
      async run() {
        return codexResult(job.id);
      }
    }, async ({ result }) => ({
      result,
      commit() {},
      rollback
    }), {
      assertClaimUsable() {
        claimChecks += 1;
        if (claimChecks === 2) throw new Error("claim expired");
      }
    });

    await processor.processor.process(
      { job, settings: processor.settings, state: processor.state },
      new AbortController().signal
    );

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(store.getToolJob(job.id)).toMatchObject({
      status: "failed",
      error: { message: "claim expired" }
    });
    store.close();
  });
});

async function artifactFixture(backend: "native" | "docker") {
  await fs.mkdir(TEST_ROOT, { recursive: true });
  const root = await fs.mkdtemp(path.join(TEST_ROOT, "case-"));
  cleanupRoots.push(root);
  const jobId = "job-artifact-finalize";
  const jobRoot = path.join(root, "jobs");
  const jobDir = path.join(jobRoot, jobId);
  const outputDir = path.join(
    jobDir,
    ".codex-worker",
    "attempt-1-attempt-token",
    "outputs"
  );
  const sourcePath = path.join(outputDir, "codex-result.txt");
  const bytes = Buffer.from("CODEX-ARTIFACT-FINALIZER-OK\n", "utf8");
  const sha256 = digest(bytes);
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(sourcePath, bytes);
  const cache = new CacheStore(path.join(root, "cache"), {
    minimumFreeBytes: 0
  });
  await cache.initialize();
  const settings: CodexCoordinatorSettings = {
    enabled: true,
    timeoutMs: 5_000,
    maxConcurrency: 1,
    workspacePath: path.join(root, "agent"),
    jobRoot
  };
  const job = toolJob(jobId, {
    task: "create an artifact",
    kind: "analysis",
    __sunabot_artifact_backend: backend
  });
  const result: CodexToolResult = {
    ok: true,
    status: "succeeded",
    jobId,
    kind: "analysis",
    content: `Created the result in ${jobDir}.`,
    resultFile: path.join(jobDir, ".codex-worker", "result.json"),
    artifacts: [{
      schemaVersion: 1,
      relativePath: path.relative(jobDir, sourcePath),
      displayName: "codex-result.txt",
      sha256,
      sizeBytes: bytes.byteLength,
      mimeType: "text/plain"
    }]
  };
  return {
    root,
    job,
    jobDir,
    sourcePath,
    settings,
    cache,
    result,
    bytes,
    sha256
  };
}

function processorFixture(
  store: SessionStore,
  codexRunner: CodexRunner,
  finalizeCodexResult: NonNullable<
    ConstructorParameters<typeof SessionToolJobProcessor>[0]["finalizeCodexResult"]
  >,
  overrides: {
    assertClaimUsable?: (
      state: SessionClaimState,
      signal: AbortSignal
    ) => void;
  } = {}
) {
  const settings: CodexCoordinatorSettings = {
    enabled: true,
    timeoutMs: 5_000,
    maxConcurrency: 1,
    workspacePath: process.cwd(),
    jobRoot: path.join(TEST_ROOT, "processor-jobs")
  };
  const state: SessionClaimState = {
    controller: new AbortController(),
    finalized: false,
    finalizationAttempted: false,
    stopRenewal: () => undefined
  };
  return {
    settings,
    state,
    processor: new SessionToolJobProcessor({
      store,
      codexRunner,
      cleanupCodexProcess: async () => ({ status: "terminated" }),
      finalizeCodexResult,
      workerId: "artifact-finalizer-worker",
      isStopped: () => false,
      assertClaimUsable: overrides.assertClaimUsable ?? ((claim, signal) => {
        if (claim.finalized) throw new Error("claim finalized");
        if (signal.aborted) throw signal.reason;
      }),
      scheduleTurns: () => undefined,
      deferTurns: () => undefined
    })
  };
}

function claimCodexJob(store: SessionStore) {
  const sessionId = `private:${Math.floor(Math.random() * 1_000_000) + 1}`;
  store.enqueueEvent({ sessionId, kind: "incoming", payload: { text: "run" } });
  const turn = store.claimNextTurn({ workerId: "turn-worker", sessionId })!;
  store.deferTurn({
    turnId: turn.turn.id,
    workerId: "turn-worker",
    job: {
      providerCallId: `call:${sessionId}`,
      toolName: "codex",
      taskKind: "analysis",
      originalRequest: turn.event.payload,
      arguments: {
        task: "inspect",
        kind: "analysis",
        __sunabot_artifact_backend: "native"
      }
    },
    acknowledgement: { kind: "reply", payload: { text: "started" } }
  });
  const acknowledgement = store.claimNextOutbox({
    workerId: "ack-worker",
    sessionId
  })!;
  store.finishOutbox({
    outboxId: acknowledgement.id,
    workerId: "ack-worker",
    outcome: "sent"
  });
  return store.claimNextToolJob({
    workerId: "artifact-finalizer-worker",
    sessionId
  })!;
}

function toolJob(id: string, argumentsValue: unknown): ToolJobRecord {
  return {
    id,
    sessionId: "private:10001",
    originEventId: "event-1",
    originTurnId: "turn-1",
    providerCallId: "call-1",
    toolName: "codex",
    taskKind: "analysis",
    originalRequest: {},
    arguments: argumentsValue,
    status: "running",
    attempts: 1,
    attemptToken: "attempt-token",
    availableAt: Date.now(),
    ackOutboxId: "outbox-1",
    createdAt: Date.now()
  };
}

function codexResult(jobId: string): CodexToolResult {
  return {
    ok: true,
    status: "succeeded",
    jobId,
    kind: "analysis",
    content: "done",
    artifacts: [{
      schemaVersion: 1,
      relativePath: ".codex-worker/attempt-1/outputs/result.txt",
      displayName: "result.txt",
      sha256: "a".repeat(64),
      sizeBytes: 4,
      mimeType: "text/plain"
    }]
  };
}

function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function publicationPrefix(job: ToolJobRecord) {
  return `codex-${createHash("sha256")
    .update(`${job.id}\0attempt-${job.attempts}-${job.attemptToken}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function stagedResult(result: CodexToolResult) {
  return {
    result,
    commit() {},
    async rollback() {}
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
