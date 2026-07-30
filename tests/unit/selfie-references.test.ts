// @vitest-environment node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSelfieReferenceRoutes } from "../../apps/api/plugins/selfieReferenceRoutes.js";
import {
  MAX_SELFIE_REFERENCE_BYTES,
  SelfieReferenceRepository
} from "../../src/admin/selfieReferences.js";
import { SELFIE_REFERENCE_MANIFEST_FILE } from "../../services/media/selfieReferenceCatalog.js";
import { AdminMutationMutex } from "../../src/admin/mutation.js";
import { createAdminTestConfig } from "./admin-fixtures.js";

let root = "";
let workspace = "";
let repository: SelfieReferenceRepository;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-selfie-reference-"));
  const config = createAdminTestConfig(root);
  workspace = config.persona.agentWorkspace;
  await fs.mkdir(workspace, { recursive: true });
  repository = new SelfieReferenceRepository({
    getConfig: () => config,
    mutex: new AdminMutationMutex()
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("SelfieReferenceRepository", () => {
  it("stores a decoded image atomically and returns bounded content variants", async () => {
    const bytes = await image(1200, 800, "#d8edff");
    const created = await repository.create({
      fileName: "普拉娜 正面.png",
      dataBase64: bytes.toString("base64"),
      note: "常服正面"
    });

    expect(created.maxImages).toBe(9);
    expect(created.images).toHaveLength(1);
    expect(created.images[0]).toMatchObject({
      fileName: expect.stringMatching(/^普拉娜-正面-[a-f0-9]{64}\.png$/),
      note: "常服正面",
      sizeBytes: bytes.byteLength,
      width: 1200,
      height: 800,
      updatedAt: expect.any(String)
    });
    expect(created.images[0]!.id).toMatch(/^[a-f0-9]{64}$/);

    const storedPath = path.join(selfieDirectoryFor(workspace), created.images[0]!.fileName);
    const stored = await fs.readFile(storedPath);
    const mode = (await fs.stat(storedPath)).mode & 0o777;
    expect(stored.equals(bytes)).toBe(true);
    expect(mode).toBe(0o600);
    expect((await fs.readdir(selfieDirectoryFor(workspace))).some((name) => name.endsWith(".tmp"))).toBe(false);
    const manifestPath = path.join(selfieDirectoryFor(workspace), SELFIE_REFERENCE_MANIFEST_FILE);
    expect((await fs.stat(manifestPath)).mode & 0o777).toBe(0o600);
    expect(await readJsonlManifest(manifestPath)).toEqual({
      schemaVersion: 1,
      references: [{
        id: created.images[0]!.id,
        fileName: created.images[0]!.fileName,
        note: "常服正面"
      }]
    });

    const original = await repository.content(created.images[0]!.id, "original");
    const display = await repository.content(created.images[0]!.id, "display");
    const placeholder = await repository.content(created.images[0]!.id, "placeholder");
    expect(original.contentType).toBe("image/png");
    expect(original.bytes.equals(bytes)).toBe(true);
    expect(display.contentType).toBe("image/webp");
    expect(await sharp(display.bytes).metadata()).toMatchObject({ width: 640, height: 427, format: "webp" });
    expect(await sharp(placeholder.bytes).metadata()).toMatchObject({ width: 32, height: 32, format: "webp" });
  });

  it("keeps duplicate uploads idempotent and rejects a tenth reference", async () => {
    const fixtures = await Promise.all(Array.from({ length: 10 }, (_, index) => (
      image(32, 32, `#${(index + 1).toString(16).padStart(2, "0")}0203`)
    )));
    for (const [index, bytes] of fixtures.slice(0, 9).entries()) {
      await repository.create({
        fileName: `${index}.png`,
        dataBase64: bytes!.toString("base64"),
        note: `造型 ${index + 1}`
      });
    }

    const duplicate = await repository.create({
      fileName: "duplicate.png",
      dataBase64: fixtures[0]!.toString("base64"),
      note: "更新后的备注"
    });
    expect(duplicate.images).toHaveLength(9);
    expect(duplicate.images.find((reference) => reference.id === sha256(fixtures[0]!))?.note).toBe("更新后的备注");
    await expect(repository.create({
      fileName: "tenth.png",
      dataBase64: fixtures[9]!.toString("base64"),
      note: "第十张"
    })).rejects.toMatchObject({ statusCode: 409, code: "SELFIE_REFERENCE_LIMIT" });
  });

  it("opens only the manifest and requested original for one strict content read", async () => {
    let envelope;
    for (let index = 0; index < 9; index += 1) {
      const bytes = await image(32, 32, `#${(index + 1).toString(16).padStart(2, "0")}2030`);
      envelope = await repository.create({
        fileName: `${index}.png`,
        dataBase64: bytes.toString("base64"),
        note: `造型 ${index + 1}`
      });
    }
    const target = envelope!.images[4]!;
    const openFile = vi.spyOn(fs, "open");

    const placeholder = await repository.content(target.id, "placeholder");

    expect(placeholder.contentType).toBe("image/webp");
    expect(openFile.mock.calls.map(([filePath]) => path.basename(String(filePath)))).toEqual([
      SELFIE_REFERENCE_MANIFEST_FILE,
      target.fileName
    ]);
  });

  it("bounds legacy scans before opening any of ten image files", async () => {
    const selfieDirectory = selfieDirectoryFor(workspace);
    await fs.mkdir(selfieDirectory, { recursive: true });
    for (let index = 0; index < 10; index += 1) {
      await fs.writeFile(
        path.join(selfieDirectory, `${index}.png`),
        await image(16, 16, `#${index.toString(16).padStart(2, "0")}4050`)
      );
    }
    const openFile = vi.spyOn(fs, "open");

    await expect(repository.list()).rejects.toMatchObject({
      statusCode: 409,
      code: "SELFIE_REFERENCE_LIMIT"
    });
    expect(openFile).not.toHaveBeenCalled();
  });

  it("rejects an image-extension directory before opening files or writing a manifest", async () => {
    const selfieDirectory = selfieDirectoryFor(workspace);
    await fs.mkdir(path.join(selfieDirectory, "nested.png"), { recursive: true });
    const openFile = vi.spyOn(fs, "open");
    const writeFile = vi.spyOn(fs, "writeFile");

    await expect(repository.list()).rejects.toMatchObject({
      statusCode: 400,
      code: "SELFIE_REFERENCE_PATH_INVALID"
    });
    expect(openFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    await expect(fs.lstat(path.join(selfieDirectory, SELFIE_REFERENCE_MANIFEST_FILE)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("self-heals missing and inconsistent manifests only through the legacy content path", async () => {
    const selfieDirectory = selfieDirectoryFor(workspace);
    await fs.mkdir(selfieDirectory, { recursive: true });
    const bytes = await image(24, 24, "#d8edff");
    const id = sha256(bytes);
    const fileName = `泳装-${id}.png`;
    await fs.writeFile(path.join(selfieDirectory, fileName), bytes);

    await expect(repository.content(id, "original")).resolves.toMatchObject({ contentType: "image/png" });
    expect(await readJsonlManifest(path.join(selfieDirectory, SELFIE_REFERENCE_MANIFEST_FILE)))
      .toEqual({ schemaVersion: 1, references: [{ id, fileName, note: "泳装" }] });

    const staleId = "f".repeat(64);
    await writeJsonlManifest(
      path.join(selfieDirectory, SELFIE_REFERENCE_MANIFEST_FILE),
      [{ id: staleId, fileName, note: "旧备注" }]
    );
    await expect(repository.content(staleId, "original")).rejects.toMatchObject({
      statusCode: 404,
      code: "SELFIE_REFERENCE_NOT_FOUND"
    });
    expect(await readJsonlManifest(path.join(selfieDirectory, SELFIE_REFERENCE_MANIFEST_FILE)))
      .toEqual({ schemaVersion: 1, references: [{ id, fileName, note: "泳装" }] });
  });

  it("reads a legacy JSON manifest once and publishes the canonical JSONL catalog", async () => {
    const selfieDirectory = selfieDirectoryFor(workspace);
    await fs.mkdir(selfieDirectory, { recursive: true });
    const bytes = await image(24, 24, "#d8edff");
    const id = sha256(bytes);
    const fileName = `常服-${id}.png`;
    await fs.writeFile(path.join(selfieDirectory, fileName), bytes);
    await fs.writeFile(path.join(selfieDirectory, "references.json"), JSON.stringify({
      schemaVersion: 1,
      references: [{ id, fileName, note: "常服" }]
    }));

    await expect(repository.list()).resolves.toMatchObject({
      images: [{ id, fileName, note: "常服" }]
    });
    await expect(readJsonlManifest(path.join(selfieDirectory, SELFIE_REFERENCE_MANIFEST_FILE)))
      .resolves.toEqual({ schemaVersion: 1, references: [{ id, fileName, note: "常服" }] });
    await expect(fs.lstat(path.join(selfieDirectory, "references.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy image names to deterministic editable notes", async () => {
    const selfieDirectory = selfieDirectoryFor(workspace);
    await fs.mkdir(selfieDirectory, { recursive: true });
    const swimsuit = await image(48, 48, "#d8edff");
    const maid = await image(48, 48, "#fff0f6");
    const swimsuitId = sha256(swimsuit);
    const maidId = sha256(maid);
    await fs.writeFile(path.join(selfieDirectory, `泳装-${swimsuitId}.png`), swimsuit);
    await fs.writeFile(path.join(selfieDirectory, `女仆装-${maidId}.png`), maid);

    const migrated = await repository.list();
    expect(migrated.images.map(({ id, note }) => ({ id, note }))).toEqual(expect.arrayContaining([
      { id: maidId, note: "女仆装" },
      { id: swimsuitId, note: "泳装" }
    ]));
    expect(migrated.images).toHaveLength(2);
    const manifest = await readJsonlManifest(path.join(selfieDirectory, SELFIE_REFERENCE_MANIFEST_FILE));
    expect(manifest.references.map(({ id, note }: { id: string; note: string }) => ({ id, note }))).toEqual(expect.arrayContaining([
      { id: maidId, note: "女仆装" },
      { id: swimsuitId, note: "泳装" }
    ]));

    const updated = await repository.updateNote(swimsuitId, { note: "海边泳装" });
    expect(updated.images.find((reference) => reference.id === swimsuitId)?.note).toBe("海边泳装");
    expect((await repository.list()).images.find((reference) => reference.id === swimsuitId)?.note).toBe("海边泳装");

    await fs.rename(
      path.join(selfieDirectory, `泳装-${swimsuitId}.png`),
      path.join(selfieDirectory, `夏日-${swimsuitId}.png`)
    );
    const renamed = await repository.list();
    expect(renamed.images.find((reference) => reference.id === swimsuitId)).toMatchObject({
      fileName: `夏日-${swimsuitId}.png`,
      note: "海边泳装"
    });
  });

  it("rejects malformed base64, disguised images, traversal and oversized payloads", async () => {
    const png = await image(16, 16, "#ffffff");
    await expect(repository.create({ fileName: "missing-note.png", dataBase64: png.toString("base64") }))
      .rejects.toMatchObject({ statusCode: 400, code: "SELFIE_REFERENCE_NOTE_INVALID", field: "note" });
    await expect(repository.create({ fileName: "empty-note.png", dataBase64: png.toString("base64"), note: "   " }))
      .rejects.toMatchObject({ statusCode: 400, code: "SELFIE_REFERENCE_NOTE_INVALID", field: "note" });
    await expect(repository.create({ fileName: "control-note.png", dataBase64: png.toString("base64"), note: "泳装\n备注" }))
      .rejects.toMatchObject({ statusCode: 400, code: "SELFIE_REFERENCE_NOTE_INVALID", field: "note" });
    await expect(repository.create({ fileName: "surrogate-note.png", dataBase64: png.toString("base64"), note: "\ud800" }))
      .rejects.toMatchObject({ statusCode: 400, code: "SELFIE_REFERENCE_NOTE_INVALID", field: "note" });
    await expect(repository.create({ fileName: "bad.png", dataBase64: "AA A=", note: "测试" }))
      .rejects.toMatchObject({ code: "SELFIE_REFERENCE_BASE64_INVALID" });
    await expect(repository.create({ fileName: "fake.png", dataBase64: Buffer.from("not an image").toString("base64"), note: "测试" }))
      .rejects.toMatchObject({ statusCode: 415, code: "SELFIE_REFERENCE_INVALID_IMAGE" });
    await expect(repository.create({ fileName: "wrong.jpg", dataBase64: png.toString("base64"), note: "测试" }))
      .rejects.toMatchObject({ statusCode: 415, code: "SELFIE_REFERENCE_TYPE_MISMATCH" });
    await expect(repository.create({ fileName: "../escape.png", dataBase64: png.toString("base64"), note: "测试" }))
      .rejects.toMatchObject({ statusCode: 400, code: "SELFIE_REFERENCE_INVALID" });
    await expect(repository.create({
      fileName: "large.png",
      dataBase64: Buffer.alloc(MAX_SELFIE_REFERENCE_BYTES + 1).toString("base64"),
      note: "测试"
    })).rejects.toMatchObject({ statusCode: 413, code: "SELFIE_REFERENCE_TOO_LARGE" });
  });

  it.each([
    ["leading Tab", "\t泳装"],
    ["trailing Tab", "泳装\t"],
    ["leading CR", "\r泳装"],
    ["trailing CR", "泳装\r"],
    ["leading LF", "\n泳装"],
    ["trailing LF", "泳装\n"]
  ])("rejects a raw %s note before any file write", async (_caseName, note) => {
    const bytes = await image(16, 16, "#ffffff");
    const writeFile = vi.spyOn(fs, "writeFile");

    await expect(repository.create({
      fileName: "invalid-note.png",
      dataBase64: bytes.toString("base64"),
      note
    })).rejects.toMatchObject({
      statusCode: 400,
      code: "SELFIE_REFERENCE_NOTE_INVALID",
      field: "note"
    });
    expect(writeFile).not.toHaveBeenCalled();
    await expect(fs.lstat(selfieDirectoryFor(workspace))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for malformed, unsafe, or symbolic-link manifests", async () => {
    const selfieDirectory = selfieDirectoryFor(workspace);
    await fs.mkdir(selfieDirectory, { recursive: true });
    const bytes = await image(16, 16, "#ffffff");
    const id = sha256(bytes);
    const fileName = `常服-${id}.png`;
    await fs.writeFile(path.join(selfieDirectory, fileName), bytes);
    const invalidManifests = [
      {
        schemaVersion: 1,
        references: [{ id, fileName, note: "" }]
      },
      {
        schemaVersion: 1,
        references: [{ id, fileName, note: "常服", sourcePath: "/tmp/outside.png" }]
      },
      {
        schemaVersion: 1,
        references: [
          { id, fileName, note: "常服" },
          { id, fileName: "duplicate.png", note: "女仆装" }
        ]
      },
      {
        schemaVersion: 1,
        references: Array.from({ length: 10 }, (_, index) => ({
          id: index.toString(16).padStart(64, "0"),
          fileName: `${index}.png`,
          note: `造型 ${index}`
        }))
      },
      {
        schemaVersion: 1,
        references: [{ id, fileName, note: "字".repeat(121) }]
      },
      {
        schemaVersion: 1,
        references: [{ id, fileName, note: String.fromCharCode(0xd800) }]
      },
      ...["\t常服", "常服\t", "\r常服", "常服\r", "\n常服", "常服\n"].map((note) => ({
        schemaVersion: 1,
        references: [{ id, fileName, note }]
      })),
      {
        schemaVersion: 1,
        references: [{ id, fileName: "../outside.png", note: "常服" }]
      },
      {
        schemaVersion: 1,
        references: [{ id, fileName: "..\\outside.png", note: "常服" }]
      }
    ];

    for (const manifest of invalidManifests) {
      await fs.writeFile(
        path.join(selfieDirectory, SELFIE_REFERENCE_MANIFEST_FILE),
        JSON.stringify(manifest)
      );
      await expect(repository.list()).rejects.toMatchObject({
        statusCode: 400,
        code: "SELFIE_REFERENCE_MANIFEST_INVALID"
      });
    }

    await fs.rm(path.join(selfieDirectory, SELFIE_REFERENCE_MANIFEST_FILE));
    const outsideManifest = path.join(root, "outside-manifest.json");
    await fs.writeFile(outsideManifest, JSON.stringify({ schemaVersion: 1, references: [] }));
    await fs.symlink(outsideManifest, path.join(selfieDirectory, SELFIE_REFERENCE_MANIFEST_FILE));
    await expect(repository.list()).rejects.toMatchObject({
      statusCode: 400,
      code: "SELFIE_REFERENCE_MANIFEST_INVALID"
    });
  });

  it("fails closed for symbolic-link directories and files", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.mkdir(path.join(workspace, "workbench"), { recursive: true });
    await fs.symlink(outside, selfieDirectoryFor(workspace));
    await expect(repository.list()).rejects.toMatchObject({
      statusCode: 400,
      code: "SELFIE_REFERENCE_PATH_INVALID"
    });

    await fs.rm(selfieDirectoryFor(workspace));
    await fs.mkdir(selfieDirectoryFor(workspace));
    const outsideImage = path.join(outside, "outside.png");
    await fs.writeFile(outsideImage, await image(16, 16, "#ffffff"));
    await fs.symlink(outsideImage, path.join(selfieDirectoryFor(workspace), "linked.png"));
    await expect(repository.list()).rejects.toMatchObject({
      statusCode: 400,
      code: "SELFIE_REFERENCE_PATH_INVALID"
    });
  });

  it("fails before open or read when O_NOFOLLOW is unavailable", async () => {
    const openFile = vi.fn();
    const readFile = vi.fn();
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        constants: { ...actual.constants, O_NOFOLLOW: undefined }
      };
    });
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        default: { ...actual, open: openFile, readFile },
        open: openFile,
        readFile
      };
    });

    try {
      const catalog = await import("../../services/media/selfieReferenceCatalog.js");
      await expect(catalog.readSelfieReferenceImageFile("/tmp/no-follow.png")).rejects.toMatchObject({
        code: "SELFIE_REFERENCE_NOFOLLOW_UNAVAILABLE"
      });
      await expect(catalog.readSelfieReferenceManifest("/tmp/no-follow")).rejects.toMatchObject({
        code: "SELFIE_REFERENCE_NOFOLLOW_UNAVAILABLE"
      });
      expect(openFile).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("node:fs");
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });
});

describe("selfie reference routes", () => {
  it("returns the WebUI envelope, content URLs and deletes by content ID", async () => {
    const app = Fastify();
    registerSelfieReferenceRoutes(app, { repository });
    const empty = await app.inject({ method: "GET", url: "/api/selfie-references" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ images: [], maxImages: 9 });

    const bytes = await image(900, 1200, "#f4f7ff");
    const encodedWebp = (await sharp(bytes).webp().toBuffer()).toString("base64");
    const missingNote = await app.inject({
      method: "POST",
      url: "/api/selfie-references",
      payload: { fileName: "plana.webp", dataBase64: encodedWebp }
    });
    expect(missingNote.statusCode).toBe(400);
    expect(missingNote.json()).toMatchObject({ code: "SELFIE_REFERENCE_NOTE_INVALID" });

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/selfie-references",
      payload: {
        fileName: "plana.webp",
        dataBase64: encodedWebp,
        note: "冬季制服"
      }
    });
    expect(uploaded.statusCode).toBe(201);
    const envelope = uploaded.json();
    const reference = envelope.images[0];
    expect(envelope.maxImages).toBe(9);
    expect(reference).toMatchObject({
      note: "冬季制服",
      originalUrl: `/api/selfie-references/${reference.id}/content?variant=original`,
      displayUrl: `/api/selfie-references/${reference.id}/content?variant=display`,
      placeholderUrl: `/api/selfie-references/${reference.id}/content?variant=placeholder`
    });

    const display = await app.inject({ method: "GET", url: reference.displayUrl });
    expect(display.statusCode).toBe(200);
    expect(display.headers["content-type"]).toContain("image/webp");
    expect(display.headers["cache-control"]).toContain("immutable");
    expect(await sharp(display.rawPayload).metadata()).toMatchObject({ width: 480, height: 640 });

    const invalidVariant = await app.inject({
      method: "GET",
      url: `/api/selfie-references/${reference.id}/content?variant=huge`
    });
    expect(invalidVariant.statusCode).toBe(400);
    expect(invalidVariant.json()).toMatchObject({ message: "自拍参考图尺寸无效。" });

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/selfie-references/${reference.id}`,
      payload: { note: "泳装" }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().images[0]).toMatchObject({
      id: reference.id,
      note: "泳装",
      displayUrl: reference.displayUrl
    });

    const invalidPatch = await app.inject({
      method: "PATCH",
      url: `/api/selfie-references/${reference.id}`,
      payload: { note: "泳装", extra: true }
    });
    expect(invalidPatch.statusCode).toBe(400);
    expect(invalidPatch.json()).toMatchObject({ code: "SELFIE_REFERENCE_INVALID" });

    const removed = await app.inject({ method: "DELETE", url: `/api/selfie-references/${reference.id}` });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/selfie-references" })).json()).toEqual({ images: [], maxImages: 9 });
    await app.close();
  });

  it("routes reference storage and content URLs by Agent ID", async () => {
    const planaWorkspace = path.join(root, "agents", "plana");
    const aronaWorkspace = path.join(root, "agents", "arona");
    await Promise.all([
      fs.mkdir(planaWorkspace, { recursive: true }),
      fs.mkdir(aronaWorkspace, { recursive: true })
    ]);
    const repositoryFor = (agentId: string) => new SelfieReferenceRepository({
      getConfig: () => ({
        ...createAdminTestConfig(root),
        persona: {
          ...createAdminTestConfig(root).persona,
          defaultAgentId: agentId,
          agentWorkspace: agentId === "arona" ? aronaWorkspace : planaWorkspace
        }
      }),
      mutex: new AdminMutationMutex()
    });
    const repositories = {
      plana: repositoryFor("plana"),
      arona: repositoryFor("arona")
    };
    const app = Fastify();
    registerSelfieReferenceRoutes(app, {
      repository: repositories.plana,
      getRepository: (agentId) => {
        const selected = repositories[agentId as keyof typeof repositories];
        if (!selected) throw new Error(`Unknown test Agent: ${agentId}`);
        return selected;
      }
    });

    const aronaBytes = await image(64, 64, "#d9f1ff");
    const planaBytes = await image(64, 64, "#fff0f6");
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/selfie-references?agentId=arona",
      payload: { fileName: "arona.png", dataBase64: aronaBytes.toString("base64"), note: "常服" }
    });
    expect(uploaded.statusCode).toBe(201);
    const reference = uploaded.json().images[0];
    const planaUpload = await app.inject({
      method: "POST",
      url: "/api/selfie-references?agentId=plana",
      payload: { fileName: "plana.png", dataBase64: planaBytes.toString("base64"), note: "女仆装" }
    });
    expect(planaUpload.statusCode).toBe(201);
    const planaReference = planaUpload.json().images[0];
    expect(reference.displayUrl).toBe(
      `/api/selfie-references/${reference.id}/content?variant=display&agentId=arona`
    );
    expect(await fs.readdir(selfieDirectoryFor(aronaWorkspace))).toHaveLength(2);
    expect(await fs.readdir(selfieDirectoryFor(planaWorkspace))).toHaveLength(2);

    const [aronaList, planaList] = await Promise.all([
      app.inject({ method: "GET", url: "/api/selfie-references?agentId=arona" }),
      app.inject({ method: "GET", url: "/api/selfie-references?agentId=plana" })
    ]);
    expect(aronaList.json().images.map(({ id }: { id: string }) => id)).toEqual([reference.id]);
    expect(planaList.json().images.map(({ id }: { id: string }) => id)).toEqual([planaReference.id]);

    const crossContent = await app.inject({
      method: "GET",
      url: `/api/selfie-references/${reference.id}/content?variant=display&agentId=plana`
    });
    expect(crossContent.statusCode).toBe(404);
    const crossPatch = await app.inject({
      method: "PATCH",
      url: `/api/selfie-references/${reference.id}?agentId=plana`,
      payload: { note: "不应写入" }
    });
    expect(crossPatch.statusCode).toBe(404);
    const crossDelete = await app.inject({
      method: "DELETE",
      url: `/api/selfie-references/${reference.id}?agentId=plana`
    });
    expect(crossDelete.statusCode).toBe(404);

    const display = await app.inject({ method: "GET", url: reference.displayUrl });
    expect(display.statusCode).toBe(200);
    expect(display.headers["content-type"]).toContain("image/webp");

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/selfie-references/${reference.id}?agentId=arona`,
      payload: { note: "泳装" }
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().images[0]).toMatchObject({ id: reference.id, note: "泳装" });
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/selfie-references/${reference.id}?agentId=arona`
    });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/selfie-references?agentId=arona" })).json().images)
      .toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/selfie-references?agentId=plana" })).json().images[0].id)
      .toBe(planaReference.id);
    await app.close();
  });

  it("addresses Native and Docker Workbench selfie catalogs independently", async () => {
    const config = createAdminTestConfig(root);
    const repositories = {
      native: new SelfieReferenceRepository({
        getConfig: () => config,
        mutex: new AdminMutationMutex(),
        backend: "native"
      }),
      docker: new SelfieReferenceRepository({
        getConfig: () => config,
        mutex: new AdminMutationMutex(),
        backend: "docker"
      })
    };
    const app = Fastify();
    registerSelfieReferenceRoutes(app, {
      repository: repositories.native,
      getRepository: (_agentId, backend) => repositories[backend]
    });

    const bytes = await image(64, 64, "#eff8ff");
    const nativeUpload = await app.inject({
      method: "POST",
      url: "/api/selfie-references?agentId=plana&workbench=native",
      payload: {
        fileName: "native.png",
        dataBase64: bytes.toString("base64"),
        note: "Native 参考图"
      }
    });
    expect(nativeUpload.statusCode, nativeUpload.body).toBe(201);
    const upload = await app.inject({
      method: "POST",
      url: "/api/selfie-references?agentId=plana&workbench=docker",
      payload: {
        fileName: "docker.png",
        dataBase64: bytes.toString("base64"),
        note: "Docker 参考图"
      }
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const reference = upload.json().images[0];
    expect(reference.displayUrl).toContain("&workbench=docker");

    const [nativeList, dockerList] = await Promise.all([
      app.inject({ method: "GET", url: "/api/selfie-references?agentId=plana" }),
      app.inject({ method: "GET", url: "/api/selfie-references?agentId=plana&workbench=docker" })
    ]);
    expect(nativeList.json().images).toHaveLength(1);
    expect(dockerList.json().images).toHaveLength(1);
    const allList = await app.inject({
      method: "GET",
      url: "/api/selfie-references?agentId=plana&workbench=all"
    });
    expect(allList.statusCode, allList.body).toBe(200);
    expect(allList.json().images).toEqual([
      expect.objectContaining({ note: "Native 参考图", workbench: "native" }),
      expect.objectContaining({ note: "Docker 参考图", workbench: "docker" })
    ]);
    expect(allList.json().images[1].displayUrl).toContain("&workbench=docker");
    const content = await app.inject({ method: "GET", url: reference.displayUrl });
    expect(content.statusCode).toBe(200);
    await expect(fs.access(path.join(
      config.persona.agentWorkspace,
      "docker-workbench",
      "selfie",
      reference.fileName
    ))).resolves.toBeUndefined();
    await app.close();
  });
});

async function image(width: number, height: number, background: string) {
  return sharp({
    create: { width, height, channels: 4, background }
  }).png().toBuffer();
}

function sha256(bytes: Buffer) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function selfieDirectoryFor(workspace: string) {
  return path.join(workspace, "workbench/selfie");
}

async function readJsonlManifest(filePath: string) {
  const content = await fs.readFile(filePath, "utf8");
  const references = content
    ? content.trimEnd().split("\n").map((line) => {
        const { schemaVersion, ...reference } = JSON.parse(line) as {
          schemaVersion: number;
          id: string;
          fileName: string;
          note: string;
        };
        expect(schemaVersion).toBe(1);
        return reference;
      })
    : [];
  return { schemaVersion: 1, references };
}

async function writeJsonlManifest(
  filePath: string,
  references: Array<{ id: string; fileName: string; note: string }>
) {
  const content = references.length
    ? `${references.map((reference) => JSON.stringify({ schemaVersion: 1, ...reference })).join("\n")}\n`
    : "";
  await fs.writeFile(filePath, content);
}
