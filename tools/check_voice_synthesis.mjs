#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const allowedAgents = new Set(["koharu", "plana", "arona"]);

function parseArguments(argv) {
  const options = {
    workspace: "workspace",
    text: "おはようございます。今日もよろしくお願いします。",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !["--agent", "--workspace", "--text", "--base-url"].includes(name) ||
      value === undefined
    ) {
      throw new Error(
        "Usage: node tools/check_voice_synthesis.mjs --agent <koharu|plana|arona> [--workspace workspace] [--text text] [--base-url http://127.0.0.1:18083]",
      );
    }
    options[name.slice(2).replace("-", "_")] = value;
    index += 1;
  }
  if (!allowedAgents.has(options.agent))
    throw new Error("--agent must be koharu, plana, or arona.");
  if (
    typeof options.text !== "string" ||
    !options.text.trim() ||
    [...options.text].length > 300
  ) {
    throw new Error("--text must contain 1 to 300 characters.");
  }
  return options;
}

function localBaseUrl(rawValue) {
  const url = new URL(
    rawValue ||
      process.env.SUNABOT_MOSS_TTS_NANO_URL ||
      "http://127.0.0.1:18083",
  );
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "The synthesis check only accepts a loopback HTTP service URL.",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url;
}

async function readJsonResponse(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes)
    throw new Error("Voice service response is too large.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximumBytes)
    throw new Error("Voice service response is too large.");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function isWave(bytes) {
  return (
    bytes.byteLength >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WAVE"
  );
}

function waveDurationMs(bytes) {
  let byteRate = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= bytes.byteLength; ) {
    const chunkId = bytes.subarray(offset, offset + 4).toString("ascii");
    const chunkBytes = bytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkBytes;
    if (chunkEnd > bytes.byteLength)
      throw new Error("Voice service returned an invalid WAV file.");
    if (chunkId === "fmt " && chunkBytes >= 16)
      byteRate = bytes.readUInt32LE(chunkStart + 8);
    if (chunkId === "data") dataBytes += chunkBytes;
    offset = chunkEnd + (chunkBytes % 2);
  }
  if (byteRate < 1 || dataBytes < 1)
    throw new Error("Voice service returned an invalid WAV file.");
  return Math.round((dataBytes / byteRate) * 1_000);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const baseUrl = localBaseUrl(options.base_url);
  const workspaceRoot = path.resolve(options.workspace);
  const agentRoot = path.join(
    workspaceRoot,
    "business",
    "agents",
    options.agent,
  );
  const profile = JSON.parse(
    await fs.readFile(path.join(agentRoot, "voice", "profile.json"), "utf8"),
  );
  const reference = profile?.languages?.[profile?.defaultLanguage];
  if (
    profile?.enabled !== true ||
    profile?.defaultLanguage !== "ja" ||
    !reference
  ) {
    throw new Error(
      `Agent ${options.agent} does not have an enabled Japanese Voice Profile.`,
    );
  }
  const referencePath = path.resolve(agentRoot, reference.relativePath);
  if (path.relative(agentRoot, referencePath).startsWith(".."))
    throw new Error("Reference audio escaped the Agent workspace.");
  const referenceBytes = await fs.readFile(referencePath);
  if (
    referenceBytes.byteLength < 1 ||
    referenceBytes.byteLength > MAX_REFERENCE_BYTES
  )
    throw new Error("Reference audio size is invalid.");
  const referenceSha256 = createHash("sha256")
    .update(referenceBytes)
    .digest("hex");
  if (
    referenceSha256 !== reference.sha256 ||
    referenceBytes.byteLength !== reference.sizeBytes
  )
    throw new Error(
      "Reference audio no longer matches Voice Profile metadata.",
    );

  const startedAt = performance.now();
  const healthResponse = await fetch(
    new URL("health", `${baseUrl.toString().replace(/\/$/u, "")}/`),
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!healthResponse.ok)
    throw new Error(
      `Voice service health request failed with HTTP ${healthResponse.status}.`,
    );
  const health = await readJsonResponse(healthResponse, 16 * 1024);
  if (health?.status !== "ok")
    throw new Error("Voice service health response is invalid.");

  const form = new FormData();
  form.append("text", options.text);
  form.append(
    "prompt_audio",
    new Blob([referenceBytes], { type: reference.mimeType }),
    reference.fileName,
  );
  form.append("cpu_threads", "4");
  form.append("enable_text_normalization", "0");
  form.append("enable_normalize_tts_text", "1");
  const generateResponse = await fetch(
    new URL("api/generate", `${baseUrl.toString().replace(/\/$/u, "")}/`),
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!generateResponse.ok)
    throw new Error(
      `Voice synthesis failed with HTTP ${generateResponse.status}.`,
    );
  const payload = await readJsonResponse(
    generateResponse,
    Math.ceil(MAX_RESPONSE_BYTES / 3) * 4 + 64 * 1024,
  );
  if (
    typeof payload?.audio_base64 !== "string" ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(payload.audio_base64)
  )
    throw new Error("Voice service returned invalid audio data.");
  const audio = Buffer.from(payload.audio_base64, "base64");
  if (
    audio.byteLength < 1 ||
    audio.byteLength > MAX_RESPONSE_BYTES ||
    !isWave(audio)
  )
    throw new Error("Voice service returned an invalid WAV file.");
  const elapsedMs = Math.round(performance.now() - startedAt);
  const durationMs = waveDurationMs(audio);
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        agent: options.agent,
        language: "ja",
        outputBytes: audio.byteLength,
        outputSha256: createHash("sha256").update(audio).digest("hex"),
        durationMs,
        elapsedMs,
        realtimeFactor: Number((elapsedMs / durationMs).toFixed(3)),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `voice synthesis check failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
