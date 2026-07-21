// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  OpenAiSpeechClient,
  OpenAiSpeechError,
} from "../../adapters/voice/openAiSpeechClient.js";

describe("OpenAiSpeechClient", () => {
  it("checks the configured model with bearer authentication", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "gpt-4o-mini-tts" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createClient(fetchImpl);

    await expect(client.health()).resolves.toMatchObject({ ok: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://voice.example/v1/models/gpt-4o-mini-tts");
    expect(init).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Authorization: "Bearer secret-key" },
    });
  });

  it("generates WAV with built-in and custom OpenAI voice values", async () => {
    const bytes = waveFixture();
    const fetchImpl = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "audio/wav" },
        }),
    );
    const client = createClient(fetchImpl);

    await expect(
      client.generate({ text: "こんばんは。", voiceId: "alloy" }),
    ).resolves.toEqual({
      bytes,
      mimeType: "audio/wav",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await client.generate({ text: "おやすみなさい。", voiceId: "voice_arona" });

    const builtInBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    const customBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(builtInBody).toEqual({
      model: "gpt-4o-mini-tts",
      input: "こんばんは。",
      voice: "alloy",
      response_format: "wav",
      stream_format: "audio",
    });
    expect(customBody.voice).toEqual({ id: "voice_arona" });
  });

  it("rejects missing credentials and unsafe remote HTTP endpoints", () => {
    expect(
      () =>
        new OpenAiSpeechClient({
          baseUrl: "https://voice.example/v1",
          apiKey: "",
          model: "tts-model",
        }),
    ).toThrowError(
      expect.objectContaining({ code: "VOICE_PROVIDER_KEY_MISSING" }),
    );
    expect(
      () =>
        new OpenAiSpeechClient({
          baseUrl: "http://voice.example/v1",
          apiKey: "secret-key",
          model: "tts-model",
        }),
    ).toThrowError(
      expect.objectContaining({ code: "VOICE_PROVIDER_CONFIG_INVALID" }),
    );
  });

  it("maps upstream errors without exposing response bodies", async () => {
    const client = createClient(
      vi.fn(
        async () => new Response("private upstream detail", { status: 401 }),
      ),
    );
    const error = await client.health().catch((caught) => caught);

    expect(error).toBeInstanceOf(OpenAiSpeechError);
    expect(error).toMatchObject({ code: "VOICE_PROVIDER_HTTP_ERROR" });
    expect(String((error as Error).message)).not.toContain("private upstream");
  });

  it("rejects non-WAV and oversized synthesis responses", async () => {
    const invalid = createClient(
      vi.fn(async () => new Response(Buffer.from("not wav"), { status: 200 })),
    );
    await expect(
      invalid.generate({ text: "先生", voiceId: "alloy" }),
    ).rejects.toMatchObject({ code: "VOICE_PROVIDER_RESPONSE_INVALID" });

    const oversized = new OpenAiSpeechClient({
      baseUrl: "https://voice.example/v1",
      apiKey: "secret-key",
      model: "gpt-4o-mini-tts",
      maxOutputBytes: 32,
      fetchImpl: vi.fn(
        async () =>
          new Response(Buffer.alloc(64), {
            status: 200,
            headers: { "content-length": "64" },
          }),
      ),
    });
    await expect(
      oversized.generate({ text: "先生", voiceId: "alloy" }),
    ).rejects.toMatchObject({ code: "VOICE_PROVIDER_RESPONSE_TOO_LARGE" });
  });
});

function createClient(fetchImpl: typeof fetch) {
  return new OpenAiSpeechClient({
    baseUrl: "https://voice.example/v1",
    apiKey: "secret-key",
    model: "gpt-4o-mini-tts",
    fetchImpl,
  });
}

function waveFixture() {
  const data = Buffer.from([1, 0, 1, 0]);
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
