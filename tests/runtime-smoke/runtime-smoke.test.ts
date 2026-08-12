// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildNapCatSmokeConfig,
  loadSmokeContext,
  main,
  maskQq,
  scrubSecrets,
  validateActionResponse
} from "../../tooling/quality/runtime-smoke.js";
import { runOneBotSmoke } from "../../tooling/quality/runtime-smoke/onebot.js";

const temporaryDirectories: string[] = [];
const originalWorkspace = process.env.SUNABOT_WORKSPACE;
const originalPort = process.env.SUNABOT_SMOKE_ONEBOT_PORT;
const originalAdvertisedHost = process.env.SUNABOT_SMOKE_ONEBOT_ADVERTISED_HOST;
const originalConnectTimeout = process.env.SUNABOT_SMOKE_ONEBOT_CONNECT_TIMEOUT_MS;
const originalActionTimeout = process.env.SUNABOT_SMOKE_ONEBOT_ACTION_TIMEOUT_MS;
const originalProductionQq = process.env.SUNABOT_PRODUCTION_QQ;
const originalSmokeNapcatAccount = process.env.SUNABOT_SMOKE_NAPCAT_ACCOUNT;

afterEach(async () => {
  if (originalWorkspace === undefined) delete process.env.SUNABOT_WORKSPACE;
  else process.env.SUNABOT_WORKSPACE = originalWorkspace;
  if (originalPort === undefined) delete process.env.SUNABOT_SMOKE_ONEBOT_PORT;
  else process.env.SUNABOT_SMOKE_ONEBOT_PORT = originalPort;
  restoreEnvironment("SUNABOT_SMOKE_ONEBOT_ADVERTISED_HOST", originalAdvertisedHost);
  restoreEnvironment("SUNABOT_SMOKE_ONEBOT_CONNECT_TIMEOUT_MS", originalConnectTimeout);
  restoreEnvironment("SUNABOT_SMOKE_ONEBOT_ACTION_TIMEOUT_MS", originalActionTimeout);
  restoreEnvironment("SUNABOT_PRODUCTION_QQ", originalProductionQq);
  restoreEnvironment("SUNABOT_SMOKE_NAPCAT_ACCOUNT", originalSmokeNapcatAccount);
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("runtime smoke safety helpers", () => {
  it("redacts known credentials without exposing their value", () => {
    const secret = "secret-provider-token-123";
    const result = scrubSecrets(`fetch failed authorization: Bearer ${secret} api_key=${secret}`, [secret]);
    expect(result).not.toContain(secret);
    expect(result).toContain("[REDACTED]");
  });

  it("masks administrator and bot QQ numbers", () => {
    expect(maskQq("171419991")).toBe("17*****91");
    expect(maskQq("1234")).toBe("****");
  });
});

describe("NapCat smoke client isolation", () => {
  it("removes inherited clients and keeps one loopback smoke client", () => {
    const config = buildNapCatSmokeConfig({
      network: {
        httpServers: [{ enable: false }],
        websocketClients: [
          { name: "production", enable: true, url: "ws://127.0.0.1:8787/onebot/v11/ws" },
          { name: "remote", enable: true, url: "wss://example.invalid/onebot" }
        ]
      }
    }, "ws://127.0.0.1:18878/onebot/v11/ws", "test-token");

    expect(config.network.httpServers).toEqual([{ enable: false }]);
    expect(config.network.websocketClients).toEqual([
      expect.objectContaining({
        name: "sunabot-smoke",
        enable: true,
        url: "ws://127.0.0.1:18878/onebot/v11/ws",
        token: "test-token"
      })
    ]);
  });
});

describe("OneBot action response validation", () => {
  it("accepts a strict successful login response", () => {
    const response = validateActionResponse({
      status: "ok",
      retcode: 0,
      echo: "login-1",
      data: { user_id: 10001, nickname: "smoke" }
    }, { expectedEcho: "login-1", requireUserId: true });
    expect(response.data.user_id).toBe(10001);
  });

  it("accepts a strict successful send response with message_id", () => {
    const response = validateActionResponse({
      status: "ok",
      retcode: 0,
      echo: "send-1",
      data: { message_id: 98765 }
    }, { expectedEcho: "send-1", requireMessageId: true });
    expect(response.data.message_id).toBe(98765);
  });

  it.each([
    [{ status: "ok", retcode: 0, echo: "wrong", data: { message_id: 1 } }, "echo"],
    [{ status: "failed", retcode: 100, echo: "send-1", data: { message_id: 1 } }, "成功状态"],
    [{ status: "ok", retcode: 0, echo: "send-1", data: {} }, "message_id"]
  ])("rejects an invalid action response", (payload, expectedMessage) => {
    expect(() => validateActionResponse(payload, {
      expectedEcho: "send-1",
      requireMessageId: true
    })).toThrow(expectedMessage);
  });
});

describe.sequential("runtime smoke workspace isolation", () => {
  it("loads config, credentials and NapCat state from the runtime-contract layout", async () => {
    const fixture = await createSmokeWorkspace();
    process.env.SUNABOT_WORKSPACE = fixture.workspace;
    process.env.SUNABOT_SMOKE_ONEBOT_PORT = "18879";

    const context = await loadSmokeContext({
      requireProviderCredential: true,
      requireOneBotCredential: true,
      requireNapCatConfig: true
    });

    expect(context.configPath).toBe(path.join(fixture.workspace, "business/config/sunabot.json"));
    expect(context.providerEnvPath).toBe(path.join(fixture.workspace, "secrets/runtime.env"));
    expect(context.onebotUrl).toBe("ws://127.0.0.1:18879/onebot/v11/ws");
    expect(context.providerToken).toBe("provider-test-token");
    expect(context.onebotToken).toBe("onebot-test-token");
  });

  it.each([
    "host.docker.internal",
    "10.23.45.67",
    "172.20.0.1",
    "192.168.50.10"
  ])("writes a container-reachable URL for an explicitly allowed advertised host: %s", async (host) => {
    const fixture = await createSmokeWorkspace();
    process.env.SUNABOT_WORKSPACE = fixture.workspace;
    process.env.SUNABOT_SMOKE_ONEBOT_PORT = "18881";
    process.env.SUNABOT_SMOKE_ONEBOT_ADVERTISED_HOST = host;
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main(["configure-onebot", "--confirm-isolated-workspace"])).resolves.toBeUndefined();

    const configured = JSON.parse(await fs.readFile(
      path.join(fixture.workspace, "runtime/napcat/accounts/primary/config-full/onebot11_123456789.json"),
      "utf8"
    )) as { network: { websocketClients: Array<{ url: string; token: string }> } };
    expect(configured.network.websocketClients[0]?.url).not.toContain("onebot-test-token");
    expect(configured.network.websocketClients).toEqual([
      expect.objectContaining({
        url: `ws://${host}:18881/onebot/v11/ws`,
        token: "onebot-test-token"
      })
    ]);
  });

  it.each([
    "ws://host.docker.internal",
    "https://smoke-core.qa.internal",
    "host.docker.internal:18881",
    "host.docker.internal/onebot",
    "user@host.docker.internal",
    "host.docker.internal?target=production",
    "host.docker.internal#fragment",
    "host.docker.internal\\onebot",
    "onebot-test-token@host.docker.internal",
    "attacker.internal",
    "127.0.0.1.internal",
    "xn--smoke-9za.internal",
    "测试.internal",
    "::1",
    "[::1]",
    "HOST.DOCKER.INTERNAL",
    "host.docker.internal.",
    "host.docker.internal\t",
    "host.docker.internal\u007f",
    "host%2edocker%2einternal",
    "${SUNABOT_SMOKE_HOST}",
    "8.8.8.8",
    "example.com",
    "172.15.0.1",
    "172.32.0.1",
    "10",
    "10.1",
    "10.1.2",
    "167772161",
    "0x0a000001",
    "012.0.0.1",
    "10.0.01.1",
    "10.0.0.1\n",
    "10.0.0.1\u001f",
    "10.0.0.1\u0085",
    "127.000.000.001",
    "smoke_core.qa.internal",
    "smoke-core.qa.internal.",
    "smoke-core..qa.internal",
    "",
    " smoke-core.qa.internal",
    "smoke-core.qa.internal\n"
  ])("rejects an unsafe advertised host before writing NapCat config: %j", async (host) => {
    const fixture = await createSmokeWorkspace();
    process.env.SUNABOT_WORKSPACE = fixture.workspace;
    process.env.SUNABOT_SMOKE_ONEBOT_ADVERTISED_HOST = host;

    await expect(loadSmokeContext({ requireOneBotCredential: true })).rejects.toThrow(
      "SUNABOT_SMOKE_ONEBOT_ADVERTISED_HOST"
    );
  });

  it.each(["1024", "18878", "65535"])("accepts a canonical decimal OneBot port: %s", async (port) => {
    const fixture = await createSmokeWorkspace();
    process.env.SUNABOT_WORKSPACE = fixture.workspace;
    process.env.SUNABOT_SMOKE_ONEBOT_PORT = port;
    process.env.SUNABOT_SMOKE_ONEBOT_ADVERTISED_HOST = "host.docker.internal";

    await expect(loadSmokeContext({ requireOneBotCredential: true })).resolves.toMatchObject({
      onebotPort: Number(port),
      onebotUrl: `ws://host.docker.internal:${port}/onebot/v11/ws`
    });
  });

  it.each(["6099", "8787", "8788"])("rejects a production or launcher-reserved port: %s", async (port) => {
    const fixture = await createSmokeWorkspace();
    process.env.SUNABOT_WORKSPACE = fixture.workspace;
    process.env.SUNABOT_SMOKE_ONEBOT_PORT = port;

    await expect(loadSmokeContext({ requireOneBotCredential: true })).rejects.toThrow("SUNABOT_SMOKE_ONEBOT_PORT");
  });

  it.each([
    "",
    " 18878",
    "18878 ",
    "18878\n",
    "+18878",
    "018878",
    "0001",
    "0x49be",
    "1e4",
    "18878.0",
    "-1",
    "0",
    "1",
    "22",
    "80",
    "1023",
    "65536",
    "NaN",
    "Infinity"
  ])("rejects a non-canonical or out-of-range OneBot port: %j", async (port) => {
    const fixture = await createSmokeWorkspace();
    process.env.SUNABOT_WORKSPACE = fixture.workspace;
    process.env.SUNABOT_SMOKE_ONEBOT_PORT = port;

    await expect(loadSmokeContext({ requireOneBotCredential: true })).rejects.toThrow("SUNABOT_SMOKE_ONEBOT_PORT");
  });

  it("accepts an explicit ephemeral test QQ without persisting it in the workspace", async () => {
    const fixture = await createSmokeWorkspace();
    process.env.SUNABOT_WORKSPACE = fixture.workspace;
    process.env.SUNABOT_SMOKE_NAPCAT_ACCOUNT = "223344556";

    const context = await loadSmokeContext({ requireOneBotCredential: true });

    expect(context.napcatAccount).toBe("223344556");
    await expect(fs.readFile(path.join(fixture.workspace, "secrets/runtime.env"), "utf8"))
      .resolves.toContain("NAPCAT_ACCOUNT=123456789");
  });

  it("runs a read-only preflight without a provider request or QQ action", async () => {
    const fixture = await createSmokeWorkspace();
    process.env.SUNABOT_WORKSPACE = fixture.workspace;
    process.env.SUNABOT_SMOKE_ONEBOT_PORT = "18879";
    const output: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));

    await expect(main(["preflight"])).resolves.toBeUndefined();

    expect(output.join("\n")).toContain("未发起网络请求，未发送 QQ 消息");
    expect(output.join("\n")).not.toContain("provider-test-token");
    expect(output.join("\n")).not.toContain("onebot-test-token");
  });

  it("rejects a provider env file outside the isolated workspace", async () => {
    const fixture = await createSmokeWorkspace();
    const outside = path.join(fixture.root, "outside.env");
    await fs.writeFile(outside, "TEST_PROVIDER_KEY=outside-token\n", "utf8");
    const configPath = path.join(fixture.workspace, "business/config/sunabot.json");
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.providers.items[0].envFile = outside;
    await fs.writeFile(configPath, JSON.stringify(config), "utf8");
    process.env.SUNABOT_WORKSPACE = fixture.workspace;

    await expect(loadSmokeContext({ requireProviderCredential: true })).rejects.toThrow(
      /Provider 凭据文件.*必须位于隔离 workspace 内/
    );
  });

  it("sends and validates OneBot actions against a local fake NapCat only", async () => {
    const fixture = await createSmokeWorkspace();
    process.env.SUNABOT_WORKSPACE = fixture.workspace;
    process.env.SUNABOT_SMOKE_ONEBOT_PORT = "18880";
    process.env.SUNABOT_SMOKE_ONEBOT_CONNECT_TIMEOUT_MS = "5000";
    process.env.SUNABOT_SMOKE_ONEBOT_ACTION_TIMEOUT_MS = "3000";
    process.env.SUNABOT_PRODUCTION_QQ = "999999999";
    const context = await loadSmokeContext({ requireOneBotCredential: true });
    const smoke = runOneBotSmoke(context);
    const actions: Array<Record<string, unknown>> = [];
    await connectWithRetry(`${context.onebotUrl}?access_token=${encodeURIComponent(context.onebotToken)}`, (client, data) => {
      const request = JSON.parse(data.toString()) as Record<string, unknown>;
      actions.push(request);
      const action = String(request.action);
      client.send(JSON.stringify({
        status: "ok",
        retcode: 0,
        echo: request.echo,
        data: action === "get_login_info"
          ? { user_id: Number(context.napcatAccount), nickname: "smoke" }
          : { message_id: 24680 }
      }));
    });

    await expect(smoke).resolves.toMatchObject({ selfId: context.napcatAccount, messageId: "24680" });
    expect(actions.map((action) => action.action)).toEqual(["get_login_info", "send_private_msg"]);
    expect(actions[1]?.params).toMatchObject({ user_id: Number(context.adminQq) });
  });
});

async function createSmokeWorkspace() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-runtime-smoke-"));
  const root = await fs.realpath(temporaryRoot);
  temporaryDirectories.push(root);
  const workspace = path.join(root, "workspace");
  await Promise.all([
    fs.mkdir(path.join(workspace, "business/config"), { recursive: true }),
    fs.mkdir(path.join(workspace, "secrets"), { recursive: true }),
    fs.mkdir(path.join(workspace, "runtime/napcat/accounts/primary/config-full"), { recursive: true })
  ]);
  await fs.writeFile(path.join(workspace, ".sunabot-smoke-workspace.json"), JSON.stringify({
    schemaVersion: 1,
    purpose: "sunabot-runtime-smoke"
  }), "utf8");
  const config = {
    providers: {
      defaultProviderId: "test-provider",
      items: [{
        id: "test-provider",
        label: "Test Provider",
        kind: "openai-official",
        enabled: true,
        model: "test-model",
        apiKeyEnv: "TEST_PROVIDER_KEY",
        envFile: "workspace/secrets/runtime.env"
      }]
    },
    bot: { adminQq: "171419991" },
    onebot: { reverseWsPath: "/onebot/v11/ws", accessTokenEnv: "ONEBOT_ACCESS_TOKEN" }
  };
  await fs.writeFile(path.join(workspace, "business/config/sunabot.json"), JSON.stringify(config), "utf8");
  await fs.writeFile(path.join(workspace, "secrets/runtime.env"), [
    "TEST_PROVIDER_KEY=provider-test-token",
    "ONEBOT_ACCESS_TOKEN=onebot-test-token",
    "NAPCAT_ACCOUNT=123456789"
  ].join("\n"), "utf8");
  const napcat = buildNapCatSmokeConfig({}, "ws://127.0.0.1:18879/onebot/v11/ws", "onebot-test-token");
  await fs.writeFile(
    path.join(workspace, "runtime/napcat/accounts/primary/config-full/onebot11_123456789.json"),
    JSON.stringify(napcat),
    "utf8"
  );
  return { root, workspace };
}

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function connectWithRetry(url: string, onMessage: (client: WebSocket, data: WebSocket.RawData) => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const websocket = new WebSocket(url);
        websocket.on("message", (data) => onMessage(websocket, data));
        websocket.once("open", () => resolve(websocket));
        websocket.once("error", reject);
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError ?? new Error("fake NapCat connection failed");
}
