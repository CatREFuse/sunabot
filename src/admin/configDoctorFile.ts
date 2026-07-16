import { constants as fsConstants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";

export const MAX_CONFIG_DOCUMENT_BYTES = 512 * 1024;

export type ConfigDoctorFileErrorKind = "missing" | "unsafe" | "too-large" | "changed";

export class ConfigDoctorFileError extends Error {
  constructor(readonly kind: ConfigDoctorFileErrorKind) {
    super(`Config Doctor file read failed: ${kind}`);
  }
}

export async function readConfigFileNoFollow(filePath: string) {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    try {
      handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new ConfigDoctorFileError("missing");
      if (code === "ELOOP" || code === "EMLINK") throw new ConfigDoctorFileError("unsafe");
      throw error;
    }

    const opened = await handle.stat({ bigint: true });
    const linked = await lstatPath(filePath);
    assertRegularIdentity(opened, linked);
    if (opened.size > BigInt(MAX_CONFIG_DOCUMENT_BYTES)) {
      throw new ConfigDoctorFileError("too-large");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const remaining = MAX_CONFIG_DOCUMENT_BYTES + 1 - total;
      if (remaining <= 0) throw new ConfigDoctorFileError("too-large");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > MAX_CONFIG_DOCUMENT_BYTES) throw new ConfigDoctorFileError("too-large");
    }

    const completed = await handle.stat({ bigint: true });
    const current = await lstatPath(filePath);
    assertRegularIdentity(completed, current);
    if (!sameSnapshot(opened, completed)) throw new ConfigDoctorFileError("changed");
    return Buffer.concat(chunks, total);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function lstatPath(filePath: string) {
  try {
    return await fs.lstat(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigDoctorFileError("changed");
    }
    throw error;
  }
}

function assertRegularIdentity(
  opened: BigIntStats,
  linked: BigIntStats
) {
  if (!opened.isFile() || !linked.isFile() || linked.isSymbolicLink()) {
    throw new ConfigDoctorFileError("unsafe");
  }
  if (opened.dev !== linked.dev || opened.ino !== linked.ino) {
    throw new ConfigDoctorFileError("changed");
  }
}

function sameSnapshot(
  before: BigIntStats,
  after: BigIntStats
) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeNs === after.mtimeNs
    && before.ctimeNs === after.ctimeNs;
}
