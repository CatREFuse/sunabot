// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerSelfieReferenceRoutes } from "../../apps/api/plugins/selfieReferenceRoutes.js";
import {
  MAX_SELFIE_REFERENCE_BYTES,
  SelfieReferenceRepository
} from "../../src/admin/selfieReferences.js";
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
  await fs.rm(root, { recursive: true, force: true });
});

describe("SelfieReferenceRepository", () => {
  it("stores a decoded image atomically and returns bounded content variants", async () => {
    const bytes = await image(1200, 800, "#d8edff");
    const created = await repository.create({
      fileName: "普拉娜 正面.png",
      dataBase64: bytes.toString("base64")
    });

    expect(created.maxImages).toBe(3);
    expect(created.images).toHaveLength(1);
    expect(created.images[0]).toMatchObject({
      fileName: expect.stringMatching(/^普拉娜-正面-[a-f0-9]{64}\.png$/),
      sizeBytes: bytes.byteLength,
      width: 1200,
      height: 800,
      updatedAt: expect.any(String)
    });
    expect(created.images[0]!.id).toMatch(/^[a-f0-9]{64}$/);

    const storedPath = path.join(workspace, "selfie", created.images[0]!.fileName);
    const stored = await fs.readFile(storedPath);
    const mode = (await fs.stat(storedPath)).mode & 0o777;
    expect(stored.equals(bytes)).toBe(true);
    expect(mode).toBe(0o600);
    expect((await fs.readdir(path.join(workspace, "selfie"))).some((name) => name.endsWith(".tmp"))).toBe(false);

    const original = await repository.content(created.images[0]!.id, "original");
    const display = await repository.content(created.images[0]!.id, "display");
    const placeholder = await repository.content(created.images[0]!.id, "placeholder");
    expect(original.contentType).toBe("image/png");
    expect(original.bytes.equals(bytes)).toBe(true);
    expect(display.contentType).toBe("image/webp");
    expect(await sharp(display.bytes).metadata()).toMatchObject({ width: 640, height: 427, format: "webp" });
    expect(await sharp(placeholder.bytes).metadata()).toMatchObject({ width: 32, height: 32, format: "webp" });
  });

  it("keeps duplicate uploads idempotent and rejects a fourth reference", async () => {
    const fixtures = await Promise.all([
      image(32, 32, "#ff0000"),
      image(32, 32, "#00ff00"),
      image(32, 32, "#0000ff"),
      image(32, 32, "#ffffff")
    ]);
    for (const [index, bytes] of fixtures.slice(0, 3).entries()) {
      await repository.create({ fileName: `${index}.png`, dataBase64: bytes!.toString("base64") });
    }

    const duplicate = await repository.create({ fileName: "duplicate.png", dataBase64: fixtures[0]!.toString("base64") });
    expect(duplicate.images).toHaveLength(3);
    await expect(repository.create({
      fileName: "fourth.png",
      dataBase64: fixtures[3]!.toString("base64")
    })).rejects.toMatchObject({ statusCode: 409, code: "SELFIE_REFERENCE_LIMIT" });
  });

  it("rejects malformed base64, disguised images, traversal and oversized payloads", async () => {
    const png = await image(16, 16, "#ffffff");
    await expect(repository.create({ fileName: "bad.png", dataBase64: "AA A=" }))
      .rejects.toMatchObject({ code: "SELFIE_REFERENCE_BASE64_INVALID" });
    await expect(repository.create({ fileName: "fake.png", dataBase64: Buffer.from("not an image").toString("base64") }))
      .rejects.toMatchObject({ statusCode: 415, code: "SELFIE_REFERENCE_INVALID_IMAGE" });
    await expect(repository.create({ fileName: "wrong.jpg", dataBase64: png.toString("base64") }))
      .rejects.toMatchObject({ statusCode: 415, code: "SELFIE_REFERENCE_TYPE_MISMATCH" });
    await expect(repository.create({ fileName: "../escape.png", dataBase64: png.toString("base64") }))
      .rejects.toMatchObject({ statusCode: 400, code: "SELFIE_REFERENCE_INVALID" });
    await expect(repository.create({
      fileName: "large.png",
      dataBase64: Buffer.alloc(MAX_SELFIE_REFERENCE_BYTES + 1).toString("base64")
    })).rejects.toMatchObject({ statusCode: 413, code: "SELFIE_REFERENCE_TOO_LARGE" });
  });

  it("fails closed for symbolic-link directories and files", async () => {
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(workspace, "selfie"));
    await expect(repository.list()).rejects.toMatchObject({
      statusCode: 400,
      code: "SELFIE_REFERENCE_PATH_INVALID"
    });

    await fs.rm(path.join(workspace, "selfie"));
    await fs.mkdir(path.join(workspace, "selfie"));
    const outsideImage = path.join(outside, "outside.png");
    await fs.writeFile(outsideImage, await image(16, 16, "#ffffff"));
    await fs.symlink(outsideImage, path.join(workspace, "selfie", "linked.png"));
    await expect(repository.list()).rejects.toMatchObject({
      statusCode: 400,
      code: "SELFIE_REFERENCE_PATH_INVALID"
    });
  });
});

describe("selfie reference routes", () => {
  it("returns the WebUI envelope, content URLs and deletes by content ID", async () => {
    const app = Fastify();
    registerSelfieReferenceRoutes(app, { repository });
    const empty = await app.inject({ method: "GET", url: "/api/selfie-references" });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ images: [], maxImages: 3 });

    const bytes = await image(900, 1200, "#f4f7ff");
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/selfie-references",
      payload: { fileName: "plana.webp", dataBase64: (await sharp(bytes).webp().toBuffer()).toString("base64") }
    });
    expect(uploaded.statusCode).toBe(201);
    const envelope = uploaded.json();
    const reference = envelope.images[0];
    expect(envelope.maxImages).toBe(3);
    expect(reference).toMatchObject({
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

    const removed = await app.inject({ method: "DELETE", url: `/api/selfie-references/${reference.id}` });
    expect(removed.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/selfie-references" })).json()).toEqual({ images: [], maxImages: 3 });
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

    const bytes = await image(64, 64, "#d9f1ff");
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/selfie-references?agentId=arona",
      payload: { fileName: "arona.png", dataBase64: bytes.toString("base64") }
    });
    expect(uploaded.statusCode).toBe(201);
    const reference = uploaded.json().images[0];
    expect(reference.displayUrl).toBe(
      `/api/selfie-references/${reference.id}/content?variant=display&agentId=arona`
    );
    expect(await fs.readdir(path.join(aronaWorkspace, "selfie"))).toHaveLength(1);
    await expect(fs.readdir(path.join(planaWorkspace, "selfie"))).rejects.toMatchObject({ code: "ENOENT" });

    const display = await app.inject({ method: "GET", url: reference.displayUrl });
    expect(display.statusCode).toBe(200);
    expect(display.headers["content-type"]).toContain("image/webp");
    await app.close();
  });
});

async function image(width: number, height: number, background: string) {
  return sharp({
    create: { width, height, channels: 4, background }
  }).png().toBuffer();
}
