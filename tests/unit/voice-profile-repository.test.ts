// @vitest-environment node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VoiceProfileRepository,
  defaultVoiceProfile,
  type VoiceLanguage,
  type VoiceReferenceUpload,
} from "../../services/voice/public.js";

let root = "";
let workspace = "";
let repository: VoiceProfileRepository;
const updatedAt = new Date("2026-07-19T08:09:10.000Z");

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-voice-profile-"));
  workspace = path.join(root, "agent");
  await fs.mkdir(workspace);
  repository = new VoiceProfileRepository({
    agentWorkspace: workspace,
    now: () => updatedAt,
  });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("VoiceProfileRepository", () => {
  it("returns a disabled Japanese profile before voice files exist", async () => {
    await expect(repository.readProfile()).resolves.toEqual(
      defaultVoiceProfile(),
    );
    await expect(fs.lstat(path.join(workspace, "voice"))).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });

  it("stores the canonical metadata contract and returns verified runtime bytes", async () => {
    const bytes = waveFixture(7);
    const profile = await repository.putReference(
      upload("ja", bytes, {
        fileName: "小春-日语.wav",
        referenceText: "おはようございます。",
        sourceUrl: "https://kivo.wiki/audio/koharu.wav?version=1",
        characterUrl: "https://kivo.wiki/characters/koharu",
      }),
    );
    const metadata = profile.languages.ja!;

    expect(metadata).toEqual({
      language: "ja",
      fileName: "小春-日语.wav",
      relativePath: expect.stringMatching(
        /^voice\/references\/reference-[a-f0-9]{64}\.wav$/u,
      ),
      mimeType: "audio/wav",
      sizeBytes: bytes.byteLength,
      sha256: sha256(bytes),
      referenceText: "おはようございます。",
      sourceUrl: "https://kivo.wiki/audio/koharu.wav?version=1",
      characterUrl: "https://kivo.wiki/characters/koharu",
      updatedAt: updatedAt.toISOString(),
    });
    expect(Object.keys(metadata).sort()).toEqual([
      "characterUrl",
      "fileName",
      "language",
      "mimeType",
      "referenceText",
      "relativePath",
      "sha256",
      "sizeBytes",
      "sourceUrl",
      "updatedAt",
    ]);

    const storedProfile = JSON.parse(
      await fs.readFile(path.join(workspace, "voice", "profile.json"), "utf8"),
    );
    expect(storedProfile.languages.ja).toEqual(metadata);
    expect(storedProfile.languages.ja.reference).toBeUndefined();
    expect(storedProfile.languages.ja.sourceText).toBeUndefined();
    expect(
      (await fs.stat(path.join(workspace, metadata.relativePath))).mode & 0o777,
    ).toBe(0o600);

    await expect(repository.readRuntimeProfile()).rejects.toMatchObject({
      code: "VOICE_DISABLED",
    });
    await repository.updateSettings({ enabled: true, defaultLanguage: "ja" });
    const runtime = await repository.readRuntimeProfile();
    expect(runtime.language).toBe("ja");
    expect(runtime.bytes.equals(bytes)).toBe(true);
    expect(runtime.metadata).toEqual(metadata);
  });

  it("requires a reference before enabling the selected default language", async () => {
    await expect(
      repository.updateSettings({ enabled: true, defaultLanguage: "ja" }),
    ).rejects.toMatchObject({
      code: "VOICE_DEFAULT_REFERENCE_REQUIRED",
      status: 409,
    });

    await repository.putReference(upload("ja", waveFixture(1)));
    await repository.updateSettings({ enabled: true, defaultLanguage: "ja" });
    await expect(
      repository.updateSettings({ enabled: true, defaultLanguage: "zh" }),
    ).rejects.toMatchObject({
      code: "VOICE_DEFAULT_REFERENCE_REQUIRED",
      status: 409,
    });
    await expect(repository.removeReference("ja")).rejects.toMatchObject({
      code: "VOICE_DEFAULT_REFERENCE_REQUIRED",
      status: 409,
    });
  });

  it("serializes repositories for one workspace without losing language updates", async () => {
    const repositories = Array.from(
      { length: 3 },
      () =>
        new VoiceProfileRepository({
          agentWorkspace: workspace,
          now: () => updatedAt,
        }),
    );
    await Promise.all(
      (
        [
          ["zh", 11],
          ["en", 22],
          ["ja", 33],
        ] as const
      ).map(([language, sample], index) =>
        repositories[index]!.putReference(
          upload(language, waveFixture(sample), {
            fileName: `${language}.wav`,
            referenceText: `${language} reference`,
          }),
        ),
      ),
    );

    const profile = await repository.readProfile();
    expect(profile.languages.zh?.language).toBe("zh");
    expect(profile.languages.en?.language).toBe("en");
    expect(profile.languages.ja?.language).toBe("ja");
  });

  it("removes an unreferenced old blob after replacement", async () => {
    const first = await repository.putReference(upload("ja", waveFixture(1)));
    const firstPath = path.join(workspace, first.languages.ja!.relativePath);
    const second = await repository.putReference(upload("ja", waveFixture(2)));

    expect(second.languages.ja!.relativePath).not.toBe(
      first.languages.ja!.relativePath,
    );
    await expect(fs.lstat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.readFile(path.join(workspace, second.languages.ja!.relativePath)),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it("rejects unsafe metadata, invalid base64 and unknown stored schema fields", async () => {
    await expect(
      repository.putReference({
        ...upload("ja", waveFixture(1)),
        referenceText: "",
      }),
    ).rejects.toMatchObject({ code: "VOICE_REFERENCE_TEXT_INVALID" });
    await expect(
      repository.putReference({
        ...upload("ja", waveFixture(1)),
        sourceUrl: "http://kivo.wiki/reference.wav",
      }),
    ).rejects.toMatchObject({ code: "VOICE_REFERENCE_URL_INVALID" });
    await expect(
      repository.putReference({
        ...upload("ja", waveFixture(1)),
        dataBase64: "not-base64",
      }),
    ).rejects.toMatchObject({ code: "VOICE_REFERENCE_BASE64_INVALID" });

    const created = await repository.putReference(upload("ja", waveFixture(1)));
    const profilePath = path.join(workspace, "voice", "profile.json");
    const stored = JSON.parse(await fs.readFile(profilePath, "utf8"));
    stored.languages.ja.unexpected = true;
    await fs.writeFile(profilePath, `${JSON.stringify(stored)}\n`, {
      mode: 0o600,
    });
    await expect(repository.readProfile()).rejects.toMatchObject({
      code: "VOICE_PROFILE_INVALID",
    });
    expect(created.languages.ja).not.toBeNull();
  });

  it("rejects symlinked and content-tampered reference files", async () => {
    const created = await repository.putReference(upload("ja", waveFixture(1)));
    const storedPath = path.join(workspace, created.languages.ja!.relativePath);
    const outside = path.join(root, "outside.wav");
    await fs.writeFile(outside, waveFixture(1), { mode: 0o600 });
    await fs.unlink(storedPath);
    await fs.symlink(outside, storedPath);
    await expect(repository.readReference("ja")).rejects.toMatchObject({
      code: "VOICE_REFERENCE_PATH_INVALID",
    });

    await fs.unlink(storedPath);
    await fs.writeFile(storedPath, waveFixture(9), { mode: 0o600 });
    await expect(repository.readReference("ja")).rejects.toMatchObject({
      code: "VOICE_REFERENCE_CHANGED",
    });
  });

  it("rejects a redirected references directory and hard-linked audio", async () => {
    const created = await repository.putReference(upload("ja", waveFixture(1)));
    const references = path.join(workspace, "voice", "references");
    const moved = path.join(root, "moved-references");
    await fs.rename(references, moved);
    await fs.symlink(moved, references);
    await expect(repository.readReference("ja")).rejects.toMatchObject({
      code: "VOICE_REFERENCE_PATH_INVALID",
    });

    await fs.unlink(references);
    await fs.rename(moved, references);
    await fs.link(
      path.join(workspace, created.languages.ja!.relativePath),
      path.join(root, "linked.wav"),
    );
    await expect(repository.readReference("ja")).rejects.toMatchObject({
      code: "VOICE_REFERENCE_PATH_INVALID",
    });
  });
});

function upload(
  language: VoiceLanguage,
  bytes: Buffer,
  overrides: Partial<VoiceReferenceUpload> = {},
): VoiceReferenceUpload {
  return {
    language,
    fileName: "reference.wav",
    dataBase64: bytes.toString("base64"),
    referenceText: "参考音频文本。",
    ...overrides,
  };
}

function waveFixture(sample: number) {
  const data = Buffer.from([sample & 0xff, 0, sample & 0xff, 0]);
  const bytes = Buffer.alloc(44 + data.byteLength);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(36 + data.byteLength, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(data.byteLength, 40);
  data.copy(bytes, 44);
  return bytes;
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
