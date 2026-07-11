import fs from "node:fs/promises";
import path from "node:path";

export interface OutboundMediaDeliveryOptions {
  rootDir: string;
}

export class OutboundMediaDelivery {
  private readonly rootDir: string;

  constructor(options: OutboundMediaDeliveryOptions) {
    this.rootDir = path.resolve(options.rootDir);
  }

  async createReference(filePath: string) {
    const resolvedPath = path.resolve(filePath);
    const relativePath = path.relative(this.rootDir, resolvedPath);
    if (!relativePath || relativePath.startsWith(`..${path.sep}`) || relativePath === ".." || path.isAbsolute(relativePath)) {
      throw new Error("Outbound media file is outside the outbound media root.");
    }
    if (relativePath.includes(path.sep)) {
      throw new Error("Outbound media file must be a direct child of the outbound media root.");
    }
    if (!isSafePngFileName(relativePath)) {
      throw new Error("Outbound media file must be a PNG image.");
    }

    const stats = await regularFileStats(resolvedPath);
    if (!stats) throw new Error("Outbound media file is not a regular file.");
    return resolvedPath;
  }
}

function isSafePngFileName(fileName: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i.test(fileName) &&
    path.basename(fileName) === fileName &&
    !fileName.includes("/") &&
    !fileName.includes("\\");
}

async function regularFileStats(filePath: string) {
  try {
    const stats = await fs.lstat(filePath);
    return stats.isFile() ? stats : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
