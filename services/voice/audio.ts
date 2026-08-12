import { fileTypeFromBuffer } from "file-type";
import { createHash } from "node:crypto";

export interface DetectedVoiceAudio {
  extension: string;
  mimeType: string;
  sha256: string;
}

export async function detectVoiceAudio(
  bytes: Uint8Array,
): Promise<DetectedVoiceAudio | undefined> {
  if (!bytes.byteLength) return undefined;
  const detected = await fileTypeFromBuffer(bytes);
  if (
    !detected?.mime.startsWith("audio/") ||
    !/^[a-z0-9]{1,10}$/u.test(detected.ext)
  )
    return undefined;
  return {
    extension: detected.ext.toLowerCase(),
    mimeType: detected.mime.toLowerCase(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function isWaveAudio(bytes: Uint8Array) {
  if (
    bytes.byteLength < 12 ||
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "RIFF" ||
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") !== "WAVE"
  )
    return false;
  const detected = await fileTypeFromBuffer(bytes);
  return detected?.ext === "wav" && detected.mime.startsWith("audio/");
}
