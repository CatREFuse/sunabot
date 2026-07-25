import fs from "node:fs/promises";
import {
  parentBoundRename,
  parentBoundUnlink
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

export const chatMediaPublisher = Object.freeze({
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
        expectedSource: temporaryIdentity
      });
      return false;
    } catch (error) {
      if ((error as { code?: unknown } | undefined)?.code !== "EEXIST") throw error;
      await parentBoundUnlink({
        filePath: input.temporaryPath,
        parentIdentity: input.parentIdentity,
        expectedTarget: temporaryIdentity
      });
      return true;
    }
  }
});

function chatMediaError(code: string) {
  return Object.assign(new Error(code), { code });
}
