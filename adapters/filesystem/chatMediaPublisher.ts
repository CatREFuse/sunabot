import type { BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  parentBoundRename,
  parentBoundUnlink,
  type ParentBoundRenameFault,
  type ParentBoundWorkerFailureMode
} from "./parentBoundFs.js";

interface ChatMediaPublishInput {
  temporaryPath: string;
  targetPath: string;
  parentIdentity: {
    realPath: string;
    dev: bigint;
    ino: bigint;
    ctimeNs: bigint;
  };
  expectedByteLength: number;
}

export interface ChatMediaPublisherOptions {
  renameFaultAt?: ParentBoundRenameFault;
  renameWorkerFailureMode?: ParentBoundWorkerFailureMode;
  renameWorkerTimeoutMs?: number;
}

export function createChatMediaPublisher(options: ChatMediaPublisherOptions = {}) {
  return Object.freeze({
    async publish(input: ChatMediaPublishInput) {
      const temporaryIdentity = await fs.lstat(input.temporaryPath, { bigint: true });
      if (
        !temporaryIdentity.isFile()
        || temporaryIdentity.isSymbolicLink()
        || temporaryIdentity.nlink !== 1n
        || temporaryIdentity.size !== BigInt(input.expectedByteLength)
      ) {
        throw chatMediaError("CHAT_MEDIA_PUBLISH_CONFLICT");
      }
      try {
        await parentBoundRename({
          source: input.temporaryPath,
          destination: input.targetPath,
          parentIdentity: input.parentIdentity,
          expectedSource: temporaryIdentity,
          faultAt: options.renameFaultAt,
          workerFailureMode: options.renameWorkerFailureMode,
          workerTimeoutMs: options.renameWorkerTimeoutMs
        });
        return false;
      } catch (error) {
        if ((error as { code?: unknown } | undefined)?.code !== "EEXIST") {
          if (await recoveredCompletedRename(input, temporaryIdentity)) return false;
          throw error;
        }
        await parentBoundUnlink({
          filePath: input.temporaryPath,
          parentIdentity: input.parentIdentity,
          expectedTarget: temporaryIdentity
        });
        return true;
      }
    }
  });
}

export const chatMediaPublisher = createChatMediaPublisher();

async function recoveredCompletedRename(
  input: ChatMediaPublishInput,
  temporaryIdentity: BigIntStats
) {
  try {
    const parentPath = input.parentIdentity.realPath;
    if (
      path.dirname(input.temporaryPath) !== parentPath
      || path.dirname(input.targetPath) !== parentPath
    ) {
      return false;
    }
    if (await fs.realpath(parentPath) !== parentPath) return false;
    const parent = await fs.lstat(parentPath, { bigint: true });
    if (
      !parent.isDirectory()
      || parent.isSymbolicLink()
      || parent.dev !== input.parentIdentity.dev
      || parent.ino !== input.parentIdentity.ino
    ) {
      return false;
    }
    await fs.lstat(input.temporaryPath, { bigint: true });
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") return false;
  }
  try {
    const target = await fs.lstat(input.targetPath, { bigint: true });
    return target.isFile()
      && !target.isSymbolicLink()
      && target.dev === temporaryIdentity.dev
      && target.ino === temporaryIdentity.ino
      && target.size === temporaryIdentity.size
      && target.nlink === 1n;
  } catch {
    return false;
  }
}

function chatMediaError(code: string) {
  return Object.assign(new Error(code), { code });
}
