// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  ProxyConfigurationError,
  installGlobalProxyDispatcher,
  mergeNoProxy,
  resolveProxyConfiguration
} from "../../packages/platform/proxy.mjs";

describe("runtime proxy contract", () => {
  it("prefers SUNABOT_PROXY_URL and installs a credential-safe dispatcher summary", async () => {
    const env: Record<string, string | undefined> = {
      SUNABOT_PROXY_URL: "http://proxy-user:proxy-password@proxy.example:7890",
      HTTPS_PROXY: "http://ignored.example:8080",
      NO_PROXY: "internal.example"
    };
    const dispatcher = {};
    const createDispatcher = vi.fn(() => dispatcher);
    const setDispatcher = vi.fn();

    const summary = await installGlobalProxyDispatcher({
      env,
      detectWsl: vi.fn(async () => {
        throw new Error("explicit settings must not probe WSL");
      }),
      createDispatcher,
      setDispatcher
    });

    expect(summary).toEqual({ enabled: true, mode: "auto", source: "explicit" });
    expect(JSON.stringify(summary)).not.toContain("proxy-user");
    expect(JSON.stringify(summary)).not.toContain("proxy-password");
    expect(createDispatcher).toHaveBeenCalledWith(expect.objectContaining({
      httpProxy: "http://proxy-user:proxy-password@proxy.example:7890/",
      httpsProxy: "http://proxy-user:proxy-password@proxy.example:7890/"
    }));
    expect(setDispatcher).toHaveBeenCalledWith(dispatcher);
    expect(env.HTTP_PROXY).toBe("http://proxy-user:proxy-password@proxy.example:7890/");
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
    expect(env.NO_PROXY?.split(",")).toEqual(expect.arrayContaining([
      "internal.example",
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]"
    ]));
  });

  it("normalizes standard proxy variables without WSL discovery", async () => {
    const detectWsl = vi.fn(async () => true);
    const configuration = await resolveProxyConfiguration({
      env: {
        HTTP_PROXY: "http://http-proxy.example:8080",
        https_proxy: "http://https-proxy.example:8443",
        no_proxy: "service.internal,localhost"
      },
      detectWsl
    });

    expect(configuration).toMatchObject({
      enabled: true,
      source: "environment",
      httpProxy: "http://http-proxy.example:8080/",
      httpsProxy: "http://https-proxy.example:8443/"
    });
    expect(detectWsl).not.toHaveBeenCalled();
    expect(configuration.noProxy.match(/localhost/g)).toHaveLength(1);
    expect(configuration.noProxy).toContain("127.0.0.1");
  });

  it("discovers the current WSL default gateway and probes configured ports in order", async () => {
    const probes: Array<[string, number, number]> = [];
    const configuration = await resolveProxyConfiguration({
      env: {
        SUNABOT_PROXY_MODE: "auto",
        SUNABOT_PROXY_PORTS: "7897, 7890",
        SUNABOT_PROXY_PROBE_TIMEOUT_MS: "250"
      },
      platform: "linux",
      detectWsl: vi.fn(async () => true),
      resolveDefaultGateway: vi.fn(async () => "192.0.2.44"),
      probeTcpPort: vi.fn(async (host, port, timeout) => {
        probes.push([host, port, timeout]);
        return port === 7890;
      })
    });

    expect(probes).toEqual([
      ["192.0.2.44", 7897, 250],
      ["192.0.2.44", 7890, 250]
    ]);
    expect(configuration).toMatchObject({
      enabled: true,
      source: "wsl-host",
      httpProxy: "http://192.0.2.44:7890/",
      httpsProxy: "http://192.0.2.44:7890/"
    });
  });

  it("keeps auto mode direct outside WSL and makes wsl-host failures explicit", async () => {
    const automatic = await resolveProxyConfiguration({
      env: { SUNABOT_PROXY_MODE: "auto" },
      platform: "linux",
      detectWsl: vi.fn(async () => false)
    });
    expect(automatic).toMatchObject({ enabled: false, source: "none" });

    await expect(resolveProxyConfiguration({
      env: { SUNABOT_PROXY_MODE: "wsl-host" },
      platform: "linux",
      resolveDefaultGateway: vi.fn(async () => "192.0.2.55"),
      probeTcpPort: vi.fn(async () => false)
    })).rejects.toMatchObject({
      name: "ProxyConfigurationError",
      code: "PROXY_WSL_HOST_UNREACHABLE"
    });
  });

  it("does not accept credentials in the Compose-visible discovered value", async () => {
    await expect(resolveProxyConfiguration({
      env: {
        SUNABOT_PROXY_DISCOVERED_URL: "http://user:secret@192.0.2.1:7890"
      }
    })).rejects.toBeInstanceOf(ProxyConfigurationError);
  });

  it("preserves a wildcard NO_PROXY and allows proxy mode to be disabled", async () => {
    expect(mergeNoProxy("*", "localhost")).toBe("*");
    const env: Record<string, string | undefined> = {
      SUNABOT_PROXY_MODE: "off",
      SUNABOT_PROXY_URL: "http://proxy.example:7890",
      HTTP_PROXY: "http://inherited.example:8001",
      http_proxy: "http://inherited.example:8002",
      HTTPS_PROXY: "http://inherited.example:8003",
      https_proxy: "http://inherited.example:8004",
      ALL_PROXY: "socks5://inherited.example:1080",
      all_proxy: "socks5://inherited.example:1081"
    };
    const configuration = await resolveProxyConfiguration({
      env
    });
    expect(configuration).toEqual({
      enabled: false,
      mode: "off",
      source: "none",
      noProxy: "localhost,127.0.0.1,::1,[::1]"
    });

    const summary = await installGlobalProxyDispatcher({ env });
    expect(summary).toEqual({ enabled: false, mode: "off", source: "none" });
    for (const name of [
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy"
    ]) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,[::1]");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });
});
