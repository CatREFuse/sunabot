// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MossTtsNanoClient,
  MossTtsNanoError,
} from "../../adapters/voice/mossTtsNanoClient.js";

describe("MossTtsNanoClient", () => {
  it("accepts only an explicit ok health document", async () => {
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(String(input)).toBe("http://127.0.0.1:18083/health");
        expect(init?.method).toBe("GET");
        return jsonResponse({ status: "ok", model: "MOSS-TTS-Nano" });
      },
    ) as unknown as typeof fetch;
    const client = new MossTtsNanoClient({ fetchImpl });

    await expect(client.health()).resolves.toMatchObject({
      ok: true,
      latencyMs: expect.any(Number),
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects non-ok health and does not expose response content or service paths", async () => {
    const client = new MossTtsNanoClient({
      fetchImpl: vi.fn(async () =>
        jsonResponse({ status: "loading", secretPath: "/srv/models/private" }),
      ) as unknown as typeof fetch,
    });

    const error = await client.health().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MossTtsNanoError);
    expect(error).toMatchObject({ code: "MOSS_TTS_RESPONSE_INVALID" });
    expect(String((error as Error).message)).not.toContain(
      "/srv/models/private",
    );
    expect(String((error as Error).message)).not.toContain("/health");
  });

  it("posts the bounded API-only synthesis fields and verifies the WAV result", async () => {
    const prompt = waveFixture(3);
    const generated = waveFixture(8);
    const fetchImpl = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(String(input)).toBe("http://127.0.0.1:18083/api/generate");
        expect(init?.method).toBe("POST");
        const form = init?.body as FormData;
        expect([...form.keys()]).toEqual([
          "text",
          "prompt_audio",
          "cpu_threads",
          "enable_text_normalization",
          "enable_normalize_tts_text",
        ]);
        expect(form.get("text")).toBe("おやすみなさい。大好きです。");
        expect(form.get("cpu_threads")).toBe("4");
        expect(form.get("enable_text_normalization")).toBe("0");
        expect(form.get("enable_normalize_tts_text")).toBe("1");
        const audio = form.get("prompt_audio") as Blob;
        expect(audio.type).toBe("audio/wav");
        expect(Buffer.from(await audio.arrayBuffer()).equals(prompt)).toBe(
          true,
        );
        return jsonResponse({ audio_base64: generated.toString("base64") });
      },
    ) as unknown as typeof fetch;
    const client = new MossTtsNanoClient({ fetchImpl });

    await expect(
      client.generate({
        text: "おやすみなさい。大好きです。",
        promptAudio: {
          bytes: prompt,
          fileName: "plana-ja.wav",
          mimeType: "audio/wav",
        },
      }),
    ).resolves.toEqual({
      bytes: generated,
      mimeType: "audio/wav",
      sha256: createHash("sha256").update(generated).digest("hex"),
    });
  });

  it("counts Unicode code points and enforces the 300-character tool limit", async () => {
    const generated = waveFixture(1);
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ audio_base64: generated.toString("base64") }),
    ) as unknown as typeof fetch;
    const client = new MossTtsNanoClient({ fetchImpl });
    const promptAudio = {
      bytes: waveFixture(2),
      fileName: "arona.wav",
      mimeType: "audio/wav",
    };

    await expect(
      client.generate({ text: "あ".repeat(300), promptAudio }),
    ).resolves.toMatchObject({ mimeType: "audio/wav" });
    await expect(
      client.generate({ text: "あ".repeat(301), promptAudio }),
    ).rejects.toMatchObject({ code: "MOSS_TTS_INPUT_INVALID" });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects mismatched prompt audio and malformed synthesis output", async () => {
    const client = new MossTtsNanoClient({
      fetchImpl: vi.fn(async () =>
        jsonResponse({
          audio_base64: Buffer.from("not wav").toString("base64"),
        }),
      ) as unknown as typeof fetch,
    });
    await expect(
      client.generate({
        text: "早上好。",
        promptAudio: {
          bytes: waveFixture(1),
          fileName: "voice.wav",
          mimeType: "audio/mpeg",
        },
      }),
    ).rejects.toMatchObject({ code: "MOSS_TTS_PROMPT_AUDIO_INVALID" });
    await expect(
      client.generate({
        text: "早上好。",
        promptAudio: {
          bytes: waveFixture(1),
          fileName: "voice.wav",
          mimeType: "audio/wav",
        },
      }),
    ).rejects.toMatchObject({ code: "MOSS_TTS_RESPONSE_INVALID" });
  });

  it("serializes generation requests targeting the same local service", async () => {
    const generated = waveFixture(6);
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await firstGate;
      return jsonResponse({ audio_base64: generated.toString("base64") });
    }) as unknown as typeof fetch;
    const firstClient = new MossTtsNanoClient({ fetchImpl });
    const secondClient = new MossTtsNanoClient({ fetchImpl });
    const input = {
      text: "こんばんは。",
      promptAudio: {
        bytes: waveFixture(4),
        fileName: "koharu.wav",
        mimeType: "audio/wav",
      },
    };

    const first = firstClient.generate(input);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const second = secondClient.generate(input);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    releaseFirst!();
    await Promise.all([first, second]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
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
