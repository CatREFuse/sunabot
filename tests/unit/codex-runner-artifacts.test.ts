// @vitest-environment node
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  CodexProcessSupervisor,
  prepareCodexRun,
  type CodexSpawn,
  type CodexSupervisorRequest
} from "../../adapters/codex/codexTool.js";
import { validateCodexResultArtifacts } from "../../adapters/codex/codexResult.js";
import type {
  FrozenCodexInputV1,
  FrozenCodexTextProjectionV1
} from "../../packages/contracts/tools/codex.js";

let temporaryRoot = "";

afterEach(async () => {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = "";
});

describe("Codex frozen inputs", () => {
  it("copies verified inputs into the attempt tree and exposes images through --image", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-frozen-"));
    const jobDir = path.join(temporaryRoot, "job");
    const fileBytes = Buffer.from("verified conversation attachment\n", "utf8");
    const projectedBytes = Buffer.from(
      "CODEX-INPUT-ARTIFACT-OK-20260730\n",
      "utf8"
    );
    const imageBytes = Buffer.from("verified image fixture\n", "utf8");
    const rawFileInput = await writeFrozenInput(jobDir, {
      handle: "message:885282522:file:0",
      kind: "file",
      relativePath: "inputs/source.txt",
      displayName: "source.txt"
    }, fileBytes);
    const fileInput: FrozenCodexInputV1 = {
      ...rawFileInput,
      textProjection: await writeTextProjection(
        jobDir,
        "inputs/source-text.txt",
        projectedBytes
      )
    };
    const imageInput = await writeFrozenInput(jobDir, {
      handle: "message:885282522:image:0",
      kind: "image",
      relativePath: "inputs/reference.png",
      displayName: "reference.png",
      mimeType: "image/png"
    }, imageBytes);

    const prepared = await prepareCodexRun(baseRequest(jobDir, {
      inputHandles: [fileInput.handle, imageInput.handle],
      frozenInputs: [fileInput, imageInput],
      runToken: "frozen-inputs"
    }), prepareOptions());

    expect(prepared.inputs).toHaveLength(2);
    expect(prepared.inputs.map((input) => input.workerPath)).toEqual([
      path.join(prepared.inputDir, `input-1-${fileInput.sha256}.txt`),
      path.join(prepared.inputDir, `input-2-${imageInput.sha256}.png`)
    ]);
    await expect(fs.readFile(prepared.inputs[0]!.workerPath)).resolves.toEqual(fileBytes);
    await expect(fs.readFile(prepared.inputs[1]!.workerPath)).resolves.toEqual(imageBytes);
    await expect(fs.readFile(prepared.inputs[0]!.textProjection!.workerPath))
      .resolves.toEqual(projectedBytes);
    expect((await fs.stat(prepared.inputs[0]!.workerPath)).mode & 0o777).toBe(0o400);
    expect((await fs.stat(prepared.inputs[1]!.workerPath)).mode & 0o777).toBe(0o400);

    const addDirIndex = prepared.args.indexOf("--add-dir");
    expect(addDirIndex).toBeGreaterThan(-1);
    expect(prepared.args[addDirIndex + 1]).toBe(prepared.outputDir);
    expect(prepared.args).toEqual(expect.arrayContaining([
      "--image",
      prepared.inputs[1]!.workerPath
    ]));
    expect(prepared.args).not.toEqual(expect.arrayContaining([
      "--image",
      prepared.inputs[0]!.workerPath
    ]));
    expect(prepared.prompt).toContain(prepared.outputDir);
    expect(prepared.prompt).toContain(fileInput.handle);
    expect(prepared.prompt).toContain(fileInput.sha256);
    expect(prepared.prompt).toContain("CODEX-INPUT-ARTIFACT-OK-20260730");
    expect(prepared.prompt).toContain("source=parsed_text");
    expect(prepared.prompt).not.toContain(prepared.inputs[0]!.workerPath);
    expect(prepared.prompt).toContain("artifacts=[]");
  });

  it("rejects a changed frozen text projection before starting Codex", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-projection-"));
    const jobDir = path.join(temporaryRoot, "job");
    const rawInput = await writeFrozenInput(jobDir, {
      handle: "message:885282522:file:0",
      kind: "file",
      relativePath: "inputs/source.pdf",
      displayName: "source.pdf",
      mimeType: "application/pdf"
    }, Buffer.from("%PDF-1.7\nfixture\n", "utf8"));
    const projection = await writeTextProjection(
      jobDir,
      "inputs/source-text.txt",
      Buffer.from("verified extracted PDF text\n", "utf8")
    );
    const projectionPath = path.join(jobDir, projection.relativePath);
    await fs.chmod(projectionPath, 0o600);
    await fs.writeFile(
      projectionPath,
      "changed extracted text\n",
      { mode: 0o400 }
    );

    await expect(prepareCodexRun(baseRequest(jobDir, {
      inputHandles: [rawInput.handle],
      frozenInputs: [{ ...rawInput, textProjection: projection }],
      runToken: "changed-projection"
    }), prepareOptions())).rejects.toThrow();
  });

  it.each([
    {
      name: "hash mismatch",
      mutate: (input: FrozenCodexInputV1) => ({ ...input, sha256: "0".repeat(64) })
    },
    {
      name: "size mismatch",
      mutate: (input: FrozenCodexInputV1) => ({ ...input, sizeBytes: input.sizeBytes + 1 })
    },
    {
      name: "path traversal",
      mutate: (input: FrozenCodexInputV1) => ({ ...input, relativePath: "../outside.txt" })
    }
  ])("rejects a frozen input with $name", async ({ mutate }) => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-invalid-input-"));
    const jobDir = path.join(temporaryRoot, "job");
    const input = await writeFrozenInput(jobDir, {
      handle: "message:885282522:file:0",
      kind: "file",
      relativePath: "inputs/source.txt",
      displayName: "source.txt"
    }, Buffer.from("immutable input\n", "utf8"));
    const invalid = mutate(input);

    await expect(prepareCodexRun(baseRequest(jobDir, {
      inputHandles: [input.handle],
      frozenInputs: [invalid],
      runToken: `invalid-${invalid.sizeBytes}`
    }), prepareOptions())).rejects.toThrow();
  });

  it("rejects a frozen input whose source is a symbolic link", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-input-link-"));
    const jobDir = path.join(temporaryRoot, "job");
    const inputRoot = path.join(jobDir, "inputs");
    const outsidePath = path.join(temporaryRoot, "outside.txt");
    await fs.mkdir(inputRoot, { recursive: true });
    await fs.writeFile(outsidePath, "outside\n", "utf8");
    await fs.symlink(outsidePath, path.join(inputRoot, "source.txt"));
    const input = frozenInput({
      handle: "message:885282522:file:0",
      kind: "file",
      relativePath: "inputs/source.txt",
      displayName: "source.txt",
      bytes: Buffer.from("outside\n", "utf8")
    });

    await expect(prepareCodexRun(baseRequest(jobDir, {
      inputHandles: [input.handle],
      frozenInputs: [input],
      runToken: "input-link"
    }), prepareOptions())).rejects.toThrow();
  });
});

describe("Codex result artifacts", () => {
  it("returns only host-validated output artifacts from a successful worker", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-output-"));
    const artifactBytes = Buffer.from("host validated artifact\n", "utf8");
    const child = fakeChild();
    const spawnProcess: CodexSpawn = (_command, args, _options: SpawnOptions) => {
      queueMicrotask(async () => {
        const outputDir = requiredArgument(args, "--add-dir");
        const resultFile = requiredArgument(args, "--output-last-message");
        await fs.mkdir(path.join(outputDir, "reports"), { recursive: true });
        await fs.writeFile(path.join(outputDir, "reports", "result.txt"), artifactBytes);
        await fs.writeFile(resultFile, JSON.stringify({
          status: "succeeded",
          content: "Created the requested result.",
          question: null,
          error: null,
          artifacts: [{
            relativePath: "reports/result.txt",
            displayName: "result.txt"
          }]
        }), "utf8");
        emitCompletedTurn(child);
      });
      return child;
    };
    const supervisor = new CodexProcessSupervisor({
      spawnProcess,
      environment: { PATH: "/usr/bin:/bin" },
      platform: "darwin"
    });

    const result = await supervisor.run(baseRequest(path.join(temporaryRoot, "job"), {
      runToken: "validated-output"
    }));

    expect(result).toMatchObject({
      ok: true,
      status: "succeeded",
      artifacts: [{
        schemaVersion: 1,
        displayName: "result.txt",
        sha256: sha256(artifactBytes),
        sizeBytes: artifactBytes.byteLength,
        mimeType: "text/plain"
      }]
    });
    expect(result.artifacts?.[0]?.relativePath).toMatch(
      /^\.codex-worker\/attempt-1-validated-output\/outputs\/reports\/result\.txt$/u
    );
  });

  it("rejects output path traversal before reading any artifact", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-output-traversal-"));
    const jobDir = path.join(temporaryRoot, "job");
    const outputDir = workerOutputDir(jobDir);
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(jobDir, "outside.txt"), "outside\n", "utf8");

    await expect(validateCodexResultArtifacts({
      declarations: [{
        relativePath: "../outside.txt",
        displayName: "outside.txt"
      }],
      outputDir,
      jobDir
    })).rejects.toThrow(/artifact path|escapes/u);
  });

  it("rejects an output artifact that resolves through a symbolic link", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-output-link-"));
    const jobDir = path.join(temporaryRoot, "job");
    const outputDir = workerOutputDir(jobDir);
    const outsidePath = path.join(jobDir, "outside.txt");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(outsidePath, "outside\n", "utf8");
    await fs.symlink(outsidePath, path.join(outputDir, "result.txt"));

    await expect(validateCodexResultArtifacts({
      declarations: [{
        relativePath: "result.txt",
        displayName: "result.txt"
      }],
      outputDir,
      jobDir
    })).rejects.toThrow(/symbolic link/u);
  });

  it("rejects an output directory symlink targeting the attempt auth directory", async () => {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-codex-output-root-link-"));
    const jobDir = path.join(temporaryRoot, "job");
    const attemptDir = path.dirname(workerOutputDir(jobDir));
    const authDir = path.join(attemptDir, "codex-home");
    const outputDir = path.join(attemptDir, "outputs");
    await fs.mkdir(authDir, { recursive: true });
    await fs.writeFile(path.join(authDir, "auth.json"), '{"secret":"fixture"}\n');
    await fs.symlink(authDir, outputDir);

    await expect(validateCodexResultArtifacts({
      declarations: [{
        relativePath: "auth.json",
        displayName: "auth.json"
      }],
      outputDir,
      jobDir
    })).rejects.toThrow(/output directory/u);
  });
});

function workerOutputDir(jobDir: string) {
  return path.join(jobDir, ".codex-worker", "attempt-1-test", "outputs");
}

function baseRequest(
  jobDir: string,
  overrides: Partial<CodexSupervisorRequest> = {}
): CodexSupervisorRequest {
  return {
    jobId: "job-artifacts",
    jobDir,
    executable: "/custom/codex",
    task: "Use the supplied inputs and create a result artifact.",
    kind: "analysis",
    timeoutMs: 2_000,
    terminationGraceMs: 10,
    ...overrides
  };
}

function prepareOptions() {
  return {
    environment: { PATH: "/usr/bin:/bin" },
    platform: "darwin" as const
  };
}

async function writeFrozenInput(
  jobDir: string,
  descriptor: Omit<FrozenCodexInputV1, "schemaVersion" | "sha256" | "sizeBytes">,
  bytes: Buffer
) {
  const absolutePath = path.join(jobDir, descriptor.relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes, { mode: 0o400 });
  return frozenInput({ ...descriptor, bytes });
}

async function writeTextProjection(
  jobDir: string,
  relativePath: string,
  bytes: Buffer
): Promise<FrozenCodexTextProjectionV1> {
  const absolutePath = path.join(jobDir, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, bytes, { mode: 0o400 });
  return {
    schemaVersion: 1,
    source: "parsed_text",
    relativePath,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    characterCount: bytes.toString("utf8").length,
    truncated: false
  };
}

function frozenInput(
  input: Omit<FrozenCodexInputV1, "schemaVersion" | "sha256" | "sizeBytes"> & {
    bytes: Buffer;
  }
): FrozenCodexInputV1 {
  const { bytes, ...descriptor } = input;
  return {
    schemaVersion: 1,
    ...descriptor,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength
  };
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child as ChildProcess;
}

function requiredArgument(args: string[], flag: string) {
  const value = args[args.indexOf(flag) + 1];
  if (!value) throw new Error(`${flag} argument missing`);
  return value;
}

function emitCompletedTurn(child: ChildProcess) {
  child.stdout?.write('{"type":"thread.started","thread_id":"thread-artifact"}\n');
  child.stdout?.write('{"type":"turn.started"}\n');
  child.stdout?.write('{"type":"turn.completed","usage":{"input_tokens":8,"output_tokens":3}}\n');
  child.stdout?.end();
  child.emit("close", 0, null);
}
