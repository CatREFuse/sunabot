import fs from "node:fs/promises";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const execFileAsync = promisify(execFile);
const LOOPBACK_NO_PROXY = ["localhost", "127.0.0.1", "::1", "[::1]"];
const SUPPORTED_MODES = new Set(["auto", "env", "wsl-host", "off"]);

export const PROXY_RUNTIME_CONTRACT = Object.freeze({
  defaultMode: "auto",
  supportedModes: Object.freeze(["auto", "env", "wsl-host", "off"]),
  explicitUrlEnv: "SUNABOT_PROXY_URL",
  modeEnv: "SUNABOT_PROXY_MODE",
  portsEnv: "SUNABOT_PROXY_PORTS",
  noProxyRequired: Object.freeze([...LOOPBACK_NO_PROXY])
});

/**
 * @typedef {"auto" | "env" | "wsl-host" | "off"} ProxyMode
 * @typedef {"explicit" | "environment" | "wsl-host" | "none"} ProxySource
 * @typedef {{
 *   enabled: boolean,
 *   mode: ProxyMode,
 *   source: ProxySource,
 *   httpProxy?: string,
 *   httpsProxy?: string,
 *   noProxy: string
 * }} ProxyConfiguration
 * @typedef {{
 *   env?: Record<string, string | undefined>,
 *   platform?: NodeJS.Platform,
 *   detectWsl?: (env: Record<string, string | undefined>) => Promise<boolean>,
 *   resolveDefaultGateway?: () => Promise<string | undefined>,
 *   probeTcpPort?: (host: string, port: number, timeoutMs: number) => Promise<boolean>
 * }} ResolveProxyOptions
 * @typedef {ResolveProxyOptions & {
 *   createDispatcher?: (options: {httpProxy?: string, httpsProxy?: string, noProxy: string}) => unknown,
 *   setDispatcher?: (dispatcher: unknown) => void
 * }} InstallProxyOptions
 */

export class ProxyConfigurationError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = "ProxyConfigurationError";
    this.code = code;
  }
}

/**
 * Resolves one proxy contract for API, Native and Docker runtimes. The WSL
 * gateway is discovered at runtime and never persisted as a fixed address.
 *
 * @param {ResolveProxyOptions} [options]
 * @returns {Promise<ProxyConfiguration>}
 */
export async function resolveProxyConfiguration(options = {}) {
  const env = options.env ?? process.env;
  const mode = parseMode(env.SUNABOT_PROXY_MODE ?? env.SUNABOT_WINDOWS_PROXY_MODE);
  const noProxy = mergeNoProxy(env.no_proxy, env.NO_PROXY);

  if (mode === "off") return disabled(mode, noProxy);

  const explicit = nonEmpty(env.SUNABOT_PROXY_URL);
  if (explicit) {
    const proxyUrl = normalizeProxyUrl(explicit, "SUNABOT_PROXY_URL");
    return enabled(mode, "explicit", proxyUrl, proxyUrl, noProxy);
  }

  const httpProxyValue = nonEmpty(env.http_proxy) ?? nonEmpty(env.HTTP_PROXY);
  const httpsProxyValue = nonEmpty(env.https_proxy) ?? nonEmpty(env.HTTPS_PROXY);
  if (httpProxyValue || httpsProxyValue) {
    const httpProxy = normalizeProxyUrl(
      httpProxyValue ?? httpsProxyValue,
      httpProxyValue ? "HTTP_PROXY" : "HTTPS_PROXY"
    );
    const httpsProxy = normalizeProxyUrl(
      httpsProxyValue ?? httpProxyValue,
      httpsProxyValue ? "HTTPS_PROXY" : "HTTP_PROXY"
    );
    return enabled(mode, "environment", httpProxy, httpsProxy, noProxy);
  }

  // The runtime launcher sets this credential-free value after resolving the
  // WSL host outside the container. It must never accept userinfo because
  // Compose may render the value during diagnostics.
  const discovered = nonEmpty(env.SUNABOT_PROXY_DISCOVERED_URL);
  if (discovered) {
    const proxyUrl = normalizeProxyUrl(discovered, "SUNABOT_PROXY_DISCOVERED_URL");
    const parsed = new URL(proxyUrl);
    if (parsed.username || parsed.password) {
      throw new ProxyConfigurationError(
        "PROXY_DISCOVERED_CREDENTIALS",
        "SUNABOT_PROXY_DISCOVERED_URL must not contain credentials"
      );
    }
    return enabled(mode, "wsl-host", proxyUrl, proxyUrl, noProxy);
  }

  if (mode === "env") return disabled(mode, noProxy);

  const platform = options.platform ?? process.platform;
  const detectWsl = options.detectWsl ?? detectWslRuntime;
  const shouldDiscover = platform === "linux"
    && (mode === "wsl-host" || await detectWsl(env));
  if (!shouldDiscover) {
    if (mode === "wsl-host") {
      throw new ProxyConfigurationError(
        "PROXY_WSL_HOST_UNSUPPORTED",
        "wsl-host proxy mode requires a Linux runtime"
      );
    }
    return disabled(mode, noProxy);
  }

  const resolveDefaultGateway = options.resolveDefaultGateway ?? discoverDefaultGateway;
  const gateway = await resolveDefaultGateway();
  if (!gateway || !isIpv4Address(gateway)) {
    if (mode === "wsl-host") {
      throw new ProxyConfigurationError(
        "PROXY_WSL_GATEWAY_MISSING",
        "wsl-host proxy mode could not resolve a default IPv4 gateway"
      );
    }
    return disabled(mode, noProxy);
  }

  const ports = parseProxyPorts(
    env.SUNABOT_PROXY_PORTS
      ?? env.SUNABOT_PROXY_PORT
      ?? env.SUNABOT_WINDOWS_PROXY_PORT
  );
  const timeoutMs = parseProbeTimeout(env.SUNABOT_PROXY_PROBE_TIMEOUT_MS);
  const probeTcpPort = options.probeTcpPort ?? canConnectTcp;
  for (const port of ports) {
    if (await probeTcpPort(gateway, port, timeoutMs)) {
      const proxyUrl = `http://${gateway}:${port}/`;
      return enabled(mode, "wsl-host", proxyUrl, proxyUrl, noProxy);
    }
  }

  if (mode === "wsl-host") {
    throw new ProxyConfigurationError(
      "PROXY_WSL_HOST_UNREACHABLE",
      "wsl-host proxy mode found no reachable configured proxy port"
    );
  }
  return disabled(mode, noProxy);
}

/**
 * Installs an Undici dispatcher before the API imports its composition root.
 * The returned summary deliberately excludes proxy URLs and credentials.
 *
 * @param {InstallProxyOptions} [options]
 * @returns {Promise<{enabled: boolean, mode: ProxyMode, source: ProxySource}>}
 */
export async function installGlobalProxyDispatcher(options = {}) {
  const configuration = await resolveProxyConfiguration(options);
  const env = options.env ?? process.env;
  applyProxyEnvironment(configuration, env);
  if (!configuration.enabled) {
    return {
      enabled: false,
      mode: configuration.mode,
      source: configuration.source
    };
  }

  const dispatcherOptions = {
    httpProxy: configuration.httpProxy,
    httpsProxy: configuration.httpsProxy,
    noProxy: configuration.noProxy
  };
  const dispatcher = options.createDispatcher
    ? options.createDispatcher(dispatcherOptions)
    : new EnvHttpProxyAgent(dispatcherOptions);
  const install = options.setDispatcher ?? setGlobalDispatcher;
  install(dispatcher);
  return {
    enabled: true,
    mode: configuration.mode,
    source: configuration.source
  };
}

/**
 * Applies the resolved values for SDKs and child processes such as Codex CLI.
 * This function never prints or returns the environment.
 *
 * @param {ProxyConfiguration} configuration
 * @param {Record<string, string | undefined>} [env]
 */
export function applyProxyEnvironment(configuration, env = process.env) {
  env.NO_PROXY = configuration.noProxy;
  env.no_proxy = configuration.noProxy;
  if (!configuration.enabled) {
    if (configuration.mode === "off") {
      for (const name of [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy"
      ]) {
        delete env[name];
      }
    }
    return;
  }
  if (configuration.httpProxy) {
    env.HTTP_PROXY = configuration.httpProxy;
    env.http_proxy = configuration.httpProxy;
  }
  if (configuration.httpsProxy) {
    env.HTTPS_PROXY = configuration.httpsProxy;
    env.https_proxy = configuration.httpsProxy;
  }
}

/** @param {string | undefined} value @returns {ProxyMode} */
function parseMode(value) {
  const mode = (nonEmpty(value) ?? "auto").toLowerCase();
  if (!SUPPORTED_MODES.has(mode)) {
    throw new ProxyConfigurationError(
      "PROXY_MODE_INVALID",
      "SUNABOT_PROXY_MODE must be auto, env, wsl-host or off"
    );
  }
  return /** @type {ProxyMode} */ (mode);
}

/** @param {string | undefined} value */
function parseProxyPorts(value) {
  const entries = nonEmpty(value)?.split(/[\s,]+/).filter(Boolean) ?? ["7890"];
  const ports = [];
  for (const entry of entries) {
    if (!/^\d{1,5}$/.test(entry)) {
      throw new ProxyConfigurationError(
        "PROXY_PORT_INVALID",
        "SUNABOT_PROXY_PORTS must contain only TCP ports"
      );
    }
    const port = Number(entry);
    if (port < 1 || port > 65_535) {
      throw new ProxyConfigurationError(
        "PROXY_PORT_INVALID",
        "SUNABOT_PROXY_PORTS contains an out-of-range TCP port"
      );
    }
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

/** @param {string | undefined} value */
function parseProbeTimeout(value) {
  if (!nonEmpty(value)) return 350;
  if (!/^\d+$/.test(value)) {
    throw new ProxyConfigurationError(
      "PROXY_TIMEOUT_INVALID",
      "SUNABOT_PROXY_PROBE_TIMEOUT_MS must be an integer between 50 and 5000"
    );
  }
  const timeout = Number(value);
  if (timeout < 50 || timeout > 5_000) {
    throw new ProxyConfigurationError(
      "PROXY_TIMEOUT_INVALID",
      "SUNABOT_PROXY_PROBE_TIMEOUT_MS must be an integer between 50 and 5000"
    );
  }
  return timeout;
}

/** @param {string} input @param {string} variableName */
function normalizeProxyUrl(input, variableName) {
  try {
    const parsed = new URL(input);
    if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("protocol");
    if (!parsed.hostname || parsed.search || parsed.hash) throw new Error("shape");
    if (parsed.pathname !== "/") throw new Error("path");
    return parsed.href;
  } catch {
    throw new ProxyConfigurationError(
      "PROXY_URL_INVALID",
      `${variableName} must be an HTTP(S) proxy URL`
    );
  }
}

/** @param {...(string | undefined)} values */
export function mergeNoProxy(...values) {
  const entries = values
    .flatMap((value) => value?.split(/[\s,]+/) ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  if (entries.includes("*")) return "*";
  for (const loopback of LOOPBACK_NO_PROXY) entries.push(loopback);
  const unique = [];
  const seen = new Set();
  for (const entry of entries) {
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(entry);
  }
  return unique.join(",");
}

/** @param {Record<string, string | undefined>} env */
export async function detectWslRuntime(env = process.env) {
  if (nonEmpty(env.WSL_INTEROP) || nonEmpty(env.WSL_DISTRO_NAME)) return true;
  try {
    return /microsoft/i.test(await fs.readFile("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return false;
  }
}

export async function discoverDefaultGateway() {
  try {
    const { stdout } = await execFileAsync("ip", ["-4", "route", "show", "default"], {
      encoding: "utf8",
      timeout: 1_000,
      windowsHide: true
    });
    for (const line of stdout.split(/\r?\n/)) {
      const gateway = line.match(/^default\s+via\s+(\d{1,3}(?:\.\d{1,3}){3})(?:\s|$)/)?.[1];
      if (gateway && isIpv4Address(gateway)) return gateway;
    }
  } catch {
    // Auto mode falls back to direct networking; wsl-host mode reports a
    // stable configuration error in resolveProxyConfiguration.
  }
  return undefined;
}

/** @param {string} host @param {number} port @param {number} timeoutMs */
export function canConnectTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** @param {ProxyMode} mode @param {string} noProxy @returns {ProxyConfiguration} */
function disabled(mode, noProxy) {
  return { enabled: false, mode, source: "none", noProxy };
}

/**
 * @param {ProxyMode} mode
 * @param {Exclude<ProxySource, "none">} source
 * @param {string} httpProxy
 * @param {string} httpsProxy
 * @param {string} noProxy
 * @returns {ProxyConfiguration}
 */
function enabled(mode, source, httpProxy, httpsProxy, noProxy) {
  return { enabled: true, mode, source, httpProxy, httpsProxy, noProxy };
}

/** @param {string | undefined} value */
function nonEmpty(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** @param {string} value */
function isIpv4Address(value) {
  const parts = value.split(".");
  return parts.length === 4
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
