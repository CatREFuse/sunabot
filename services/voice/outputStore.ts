import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkbench } from "../agents/public.js";
import { isWaveAudio } from "./audio.js";
import { MAX_VOICE_OUTPUT_BYTES } from "./types.js";

const OUTPUT_DIRECTORY = ".voice-cache";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class VoiceOutputStore {
  constructor(private readonly agentWorkspace: string) {}

  async put(bytesValue: Uint8Array, expectedSha256: string) {
    const bytes = Buffer.from(bytesValue);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      !bytes.byteLength ||
      bytes.byteLength > MAX_VOICE_OUTPUT_BYTES ||
      !SHA256_PATTERN.test(expectedSha256) ||
      sha256 !== expectedSha256 ||
      !(await isWaveAudio(bytes))
    )
      throw new Error("合成语音文件无效。");

    const workbench = await resolveAgentWorkbench(this.agentWorkspace);
    const directory = await ensureOutputDirectory(workbench);
    const fileName = `voice-${sha256}.wav`;
    const filePath = path.join(directory, fileName);
    if (!(await existingMatches(filePath, bytes)))
      await publish(filePath, directory, bytes);
    return {
      path: path.posix.join(OUTPUT_DIRECTORY, fileName),
      name: fileName,
      byteLength: bytes.byteLength,
      sha256,
    };
  }
}

async function ensureOutputDirectory(workbench: string) {
  const directory = path.join(workbench, OUTPUT_DIRECTORY);
  try {
    await fs.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const [stats, canonical] = await Promise.all([
    fs.lstat(directory),
    fs.realpath(directory),
  ]);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    canonical !== directory
  ) {
    throw new Error("合成语音目录无效。");
  }
  return directory;
}

async function existingMatches(filePath: string, expected: Buffer) {
  try {
    const stats = await fs.lstat(filePath);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      stats.size !== expected.byteLength
    ) {
      throw new Error("合成语音文件冲突。");
    }
    return (await fs.readFile(filePath)).equals(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function publish(filePath: string, directory: string, bytes: Buffer) {
  const temporaryPath = path.join(
    directory,
    `.voice-${randomBytes(16).toString("hex")}.tmp`,
  );
  try {
    const handle = await fs.open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporaryPath, filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await existingMatches(filePath, bytes)))
      throw new Error("合成语音文件冲突。");
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
