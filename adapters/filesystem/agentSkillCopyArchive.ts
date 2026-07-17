import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectSkillDirectory, type SkillArchiveLimits } from "./skillArchive.js";
import { storeError } from "./agentExtensionSecureFs.js";

interface ZipEntry {
  name: string;
  content: Buffer;
}

export async function buildSkillCopyArchive(input: {
  directory: string;
  expectedDigestSha256: string;
  renameTo?: string;
  limits?: SkillArchiveLimits;
}) {
  return (await buildSkillCopyArtifact(input)).archive;
}

export async function buildSkillCopyArtifact(input: {
  directory: string;
  expectedDigestSha256: string;
  renameTo?: string;
  limits?: SkillArchiveLimits;
}) {
  const before = await inspectSkillDirectory(input.directory, input.limits);
  if (before.digestSha256 !== input.expectedDigestSha256) changed();
  const entries: ZipEntry[] = [];
  try {
    for (const evidence of before.files) {
      const absolute = path.join(input.directory, ...evidence.path.split("/"));
      let content = await readPinnedFile(absolute, evidence.bytes, evidence.sha256);
      if (input.renameTo && evidence.path === "SKILL.md") {
        const source = content;
        try {
          content = renameFrontmatter(source, before.name, input.renameTo);
        } finally {
          source.fill(0);
        }
      }
      entries.push({ name: evidence.path, content });
    }
    const after = await inspectSkillDirectory(input.directory, input.limits);
    if (after.digestSha256 !== before.digestSha256) changed();
    return { archive: storedZip(entries), digestSha256: packageDigest(entries) };
  } finally {
    for (const entry of entries) entry.content.fill(0);
  }
}

async function readPinnedFile(filePath: string, expectedBytes: number, expectedSha256: string) {
  const before = await fs.lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(expectedBytes)) changed();
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  const content = Buffer.alloc(expectedBytes);
  let complete = false;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) changed();
    let offset = 0;
    while (offset < content.length) {
      const result = await handle.read(content, offset, content.length - offset, offset);
      if (!result.bytesRead) changed();
      offset += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after) || createHash("sha256").update(content).digest("hex") !== expectedSha256) changed();
    complete = true;
    return content;
  } finally {
    await handle.close().catch(() => undefined);
    if (!complete) content.fill(0);
  }
}

function renameFrontmatter(content: Buffer, sourceName: string, targetName: string) {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { changed(); }
  const expected = `name: ${sourceName}`;
  const lines = text.split("\n");
  const index = lines.indexOf(expected);
  if (index < 1 || index > 32 || lines[0] !== "---") changed();
  lines[index] = `name: ${targetName}`;
  return Buffer.from(lines.join("\n"), "utf8");
}

function storedZip(entries: ZipEntry[]) {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.content);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.content.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

function packageDigest(entries: ZipEntry[]) {
  const hash = createHash("sha256");
  hash.update("sunabot-skill-package-v1\0");
  for (const entry of [...entries].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    hash.update(entry.name, "utf8");
    hash.update("\0");
    hash.update(String(entry.content.length), "ascii");
    hash.update("\0");
    hash.update(createHash("sha256").update(entry.content).digest("hex"), "ascii");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sameFile(left: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint },
  right: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function changed(): never {
  throw storeError(409, "SKILL_SOURCE_CHANGED", "Skill 在复制期间发生变化。");
}
