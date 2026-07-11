// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeTavilySettings,
  resolveTavilyApiKey,
  resolveTavilyApiKeys
} from "../../src/webSearchSettings.js";

let temporaryDirectory = "";

afterEach(async () => {
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("websearch settings", () => {
  it("migrates a direct Tavily key entered in the legacy env field", () => {
    const settings = normalizeTavilySettings({
      tavilyApiKey: "",
      tavilyApiKeyEnv: "tvly-test-1234567890"
    }, {
      tavilyApiKey: "",
      tavilyApiKeys: [],
      tavilyApiKeyEnv: "TAVILY_API_KEY"
    });

    expect(settings).toEqual({
      tavilyApiKey: "",
      tavilyApiKeys: ["tvly-test-1234567890"],
      tavilyApiKeyEnv: "TAVILY_API_KEY"
    });
  });

  it("resolves Tavily credentials from direct, process and project env sources", async () => {
    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-websearch-settings-"));
    await fs.writeFile(path.join(temporaryDirectory, ".env"), "PROJECT_TAVILY_KEY=project-secret\n", "utf8");

    expect(resolveTavilyApiKey({
      tavilyApiKey: "direct-secret",
      tavilyApiKeys: [],
      tavilyApiKeyEnv: "TAVILY_API_KEY"
    }, temporaryDirectory, {})).toMatchObject({ source: "direct" });
    expect(resolveTavilyApiKey({
      tavilyApiKey: "",
      tavilyApiKeys: [],
      tavilyApiKeyEnv: "RUNTIME_TAVILY_KEY"
    }, temporaryDirectory, { RUNTIME_TAVILY_KEY: "runtime-secret" })).toMatchObject({ source: "environment" });
    expect(resolveTavilyApiKey({
      tavilyApiKey: "",
      tavilyApiKeys: [],
      tavilyApiKeyEnv: "PROJECT_TAVILY_KEY"
    }, temporaryDirectory, {})).toMatchObject({ source: "project-env" });
  });

  it("resolves direct keys in order before the environment fallback", () => {
    const credentials = resolveTavilyApiKeys({
      tavilyApiKey: "",
      tavilyApiKeys: ["direct-one", "direct-two"],
      tavilyApiKeyEnv: "POOL_TAVILY_KEY"
    }, "/missing", { POOL_TAVILY_KEY: "environment-three" });

    expect(credentials.map((credential) => credential.value)).toEqual([
      "direct-one",
      "direct-two",
      "environment-three"
    ]);
  });
});
