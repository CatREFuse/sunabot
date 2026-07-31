#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const PROVIDER_ROUTE_LOCK_FIELDS = Object.freeze([
  ["bot.replyProviderId", "provider"],
  ["bot.replyModel", "model"],
  ["bot.imageReader.providerId", "provider"],
  ["bot.imageReader.model", "model"],
  ["bot.tone.providerId", "provider"],
  ["bot.tone.model", "model"],
  ["bot.memory.memoryProviderId", "provider"],
  ["bot.memory.memoryModel", "model"],
  ["bot.orchestrator.userGroupchatOrchestratorProviderId", "provider"],
  ["bot.orchestrator.userGroupchatOrchestratorModel", "model"],
  ["bot.orchestrator.groupThreadProviderId", "provider"],
  ["bot.orchestrator.groupThreadModel", "model"],
  ["bot.tools.codex.model", "model"],
  ["bot.bash.auditModel", "model"]
]);
const INLINE_SECRET_FIELD_NAMES = new Set([
  "apikey",
  "apikeys",
  "authorization",
  "bearertoken",
  "clientsecret",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "password",
  "passwords",
  "privatekey",
  "refreshtoken",
  "secret",
  "secrets",
  "tavilyapikey",
  "tavilyapikeys",
  "token",
  "tokens"
]);
const CODEX_AUTH_RELATIVE_PATH = path.join("secrets", "codex", "auth.json");
const LOCKED_CODEX_RESPONSES_BASE_URL = "https://chatgpt.com/backend-api/codex";

export async function prepareProviderSmokeWorkspace(options) {
  const source = requireAbsolute(options.source, "source");
  const destination = requireAbsolute(options.destination, "destination");
  if (samePath(source, destination)) throw new Error("源 workspace 与隔离测试 workspace 不能相同。");
  if (!options.confirmCredentialCopy) throw new Error("复制 Provider 凭据需要显式确认。");
  await assertDirectory(source, "源 workspace");
  await assertEmptyOrMissing(destination);

  const sourceConfigPath = await firstExisting([
    path.join(source, "business/config/sunabot.json"),
    path.join(source, "config/sunabot.json")
  ]);
  if (!sourceConfigPath) throw new Error("源 workspace 没有 Sunabot 配置。");
  const config = JSON.parse(await fs.readFile(sourceConfigPath, "utf8"));
  const agentId = validAgentId(options.agentId ?? config.persona?.defaultAgentId ?? "plana");
  const routeLock = providerRouteLockOptions(options);
  const copyCodexAuth = Boolean(options.copyCodexAuth);
  if (copyCodexAuth && !routeLock) {
    throw new Error("USER_TEST_CODEX_AUTH_ROUTE_LOCK_REQUIRED");
  }
  const providerId = routeLock?.providerId ?? config.providers?.defaultProviderId;
  const provider = config.providers?.items?.find((item) => item?.id === providerId);
  if (routeLock && !provider) {
    throw new Error(`USER_TEST_PROVIDER_ROUTE_LOCK_PROVIDER_NOT_FOUND: ${routeLock.providerId}`);
  }
  if (!provider?.id || !provider.apiKeyEnv) throw new Error("源 workspace 的默认 Provider 配置无效。");
  if (routeLock && provider.kind !== "codex-responses") {
    throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_PROVIDER_KIND_INVALID");
  }
  const sourceEnvPath = resolveSourcePath(source, provider.envFile || "workspace/secrets/runtime.env");
  await assertFileInside(sourceEnvPath, source, "Provider 凭据文件");
  const sourceEnvironment = dotenv.parse(await fs.readFile(sourceEnvPath, "utf8"));
  let providerToken = String(sourceEnvironment[provider.apiKeyEnv] ?? "").trim();
  if (!providerToken && provider.kind === "codex-responses") {
    const configuredAuthFile = String(
      sourceEnvironment.OPEN_ARONA_CODEX_AUTH_FILE ?? "workspace/security/codex/auth.json"
    ).trim();
    const authFile = resolveSourcePath(source, configuredAuthFile);
    await assertFileInside(authFile, source, "Codex 授权文件");
    const auth = JSON.parse(await fs.readFile(authFile, "utf8"));
    providerToken = String(auth.tokens?.access_token ?? "").trim();
  }
  if (!providerToken) throw new Error(`源 Provider 凭据未设置 ${provider.apiKeyEnv}。`);

  const destinationConfigPath = path.join(destination, "business/config/sunabot.json");
  const destinationEnvPath = path.join(destination, "secrets/runtime.env");
  const configuredDefaultAgentId = validAgentId(config.persona?.defaultAgentId ?? "plana");
  const configuredAgentWorkspace = agentId === configuredDefaultAgentId
    ? config.persona?.agentWorkspace
    : undefined;
  const agentSource = resolveSourcePath(
    source,
    configuredAgentWorkspace || `workspace/business/agents/${agentId}`
  );
  const agentDestination = path.join(destination, "business/agents", agentId);
  const onebotEnvironment = String(config.onebot?.accessTokenEnv || "ONEBOT_ACCESS_TOKEN");
  if (routeLock && provider.apiKeyEnv === onebotEnvironment) {
    throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_ENV_COLLISION");
  }
  const resolvedRouteLock = routeLock
    ? {
        ...routeLock,
        providerApiKeyEnv: provider.apiKeyEnv,
        onebotAccessTokenEnv: onebotEnvironment
      }
    : undefined;
  const preparedProvider = {
    ...provider,
    ...(routeLock ? { model: routeLock.model } : {}),
    ...(routeLock ? { baseUrl: LOCKED_CODEX_RESPONSES_BASE_URL } : {}),
    envFile: "workspace/secrets/runtime.env"
  };
  const preparedConfig = {
    ...config,
    server: { ...config.server, host: "127.0.0.1", port: options.apiPort ?? 18_876 },
    persona: {
      ...config.persona,
      defaultAgentId: agentId,
      agentWorkspace: `workspace/business/agents/${agentId}`
    },
    providers: {
      defaultProviderId: provider.id,
      items: [preparedProvider]
    }
  };
  if (routeLock) {
    stripInlineSecrets(preparedConfig);
    applyProviderRouteLock(preparedConfig, routeLock);
  }

  const agentSourceExists = await directoryExists(agentSource);
  if (!agentSourceExists && options.agentId != null) {
    throw new Error(`源 workspace 不存在 Agent：${agentId}`);
  }
  if (routeLock) {
    if (!agentSourceExists) throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_AGENT_CONFIG_REQUIRED");
    await assertFileInside(
      path.join(agentSource, "agent.json"),
      source,
      "Agent 配置"
    ).catch((error) => {
      if (error?.code === "ENOENT") {
        throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_AGENT_CONFIG_REQUIRED");
      }
      throw error;
    });
  }
  const cleanupOnFailure = Boolean(
    routeLock || typeof options.copyAgentWorkspace === "function"
  );
  try {
    await fs.mkdir(path.dirname(destinationConfigPath), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(destinationEnvPath), { recursive: true, mode: 0o700 });
    if (agentSourceExists) {
      await assertPathInside(agentSource, source, "Agent workspace");
      if (typeof options.copyAgentWorkspace === "function") {
        await options.copyAgentWorkspace({
          source: agentSource,
          destination: agentDestination,
          agentId,
          config
        });
      } else {
        await fs.cp(agentSource, agentDestination, { recursive: true, errorOnExist: true, force: false });
      }
    } else {
      await fs.mkdir(agentDestination, { recursive: true, mode: 0o700 });
    }
    const agentConfigPath = path.join(agentDestination, "agent.json");
    if (routeLock) {
      const agentConfig = JSON.parse(await fs.readFile(agentConfigPath, "utf8"));
      delete agentConfig.providers;
      stripInlineSecrets(agentConfig);
      applyProviderRouteLock(agentConfig, routeLock);
      await fs.writeFile(agentConfigPath, `${JSON.stringify(agentConfig, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600
      });
    }
    await fs.writeFile(destinationConfigPath, `${JSON.stringify(preparedConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx"
    });
    const values = new Map([[provider.apiKeyEnv, providerToken]]);
    if (!values.has(onebotEnvironment)) values.set(onebotEnvironment, crypto.randomBytes(32).toString("base64url"));
    const environmentText = [...values].map(([name, value]) => `${name}=${JSON.stringify(value)}`).join("\n");
    await fs.writeFile(destinationEnvPath, `${environmentText}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (routeLock) {
      await prepareIsolatedCodexHome({
        source,
        destination,
        copyCodexAuth
      });
    }
    if (routeLock) {
      await assertProviderRouteLockDocuments({
        configPath: destinationConfigPath,
        agentConfigPath,
        envPath: destinationEnvPath,
        providerId: routeLock.providerId,
        model: routeLock.model,
        providerApiKeyEnv: provider.apiKeyEnv,
        onebotAccessTokenEnv: onebotEnvironment
      });
    }
    return {
      source,
      destination,
      configPath: destinationConfigPath,
      envPath: destinationEnvPath,
      agentId,
      provider: {
        id: provider.id,
        kind: provider.kind,
        model: preparedProvider.model,
        apiKeyEnv: provider.apiKeyEnv
      },
      routeLock: resolvedRouteLock,
      codexAuthCopied: copyCodexAuth
    };
  } catch (error) {
    if (cleanupOnFailure) {
      await fs.rm(destination, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function assertCopiedCodexAuth(input) {
  const sourceContent = await readValidatedCodexAuth(
    input.source,
    "USER_TEST_CODEX_AUTH_SOURCE"
  );
  const destinationContent = await readValidatedCodexAuth(
    input.destination,
    "USER_TEST_CODEX_AUTH_DESTINATION",
    { requiredMode: 0o600 }
  );
  if (!sourceContent.equals(destinationContent)) {
    throw new Error("USER_TEST_CODEX_AUTH_COPY_MISMATCH");
  }
  const destinationDirectory = path.join(input.destination, path.dirname(CODEX_AUTH_RELATIVE_PATH));
  const entries = await fs.readdir(destinationDirectory);
  if (entries.length !== 1 || entries[0] !== path.basename(CODEX_AUTH_RELATIVE_PATH)) {
    throw new Error("USER_TEST_CODEX_AUTH_DESTINATION_INVALID");
  }
}

export async function resolveValidatedCodexHome(workspace, options = {}) {
  const codexHome = await resolveStandardCodexHome(
    workspace,
    "USER_TEST_CODEX_AUTH_DESTINATION"
  );
  const entries = await fs.readdir(codexHome);
  if (options.codexAuthCopied === true) {
    await readValidatedCodexAuth(
      workspace,
      "USER_TEST_CODEX_AUTH_DESTINATION",
      { requiredMode: 0o600 }
    );
    if (entries.length !== 1 || entries[0] !== path.basename(CODEX_AUTH_RELATIVE_PATH)) {
      throw new Error("USER_TEST_CODEX_AUTH_DESTINATION_INVALID");
    }
  } else if (entries.length !== 0) {
    throw new Error("USER_TEST_CODEX_AUTH_DESTINATION_NOT_EMPTY");
  }
  return codexHome;
}

export async function assertProviderRouteLockDocuments(input) {
  const providerId = requiredLockValue(input.providerId, "PROVIDER");
  const model = requiredLockValue(input.model, "MODEL");
  const providerApiKeyEnv = requiredLockValue(
    input.providerApiKeyEnv,
    "PROVIDER_API_KEY_ENV"
  );
  const onebotAccessTokenEnv = requiredLockValue(
    input.onebotAccessTokenEnv,
    "ONEBOT_ACCESS_TOKEN_ENV"
  );
  const shared = JSON.parse(await fs.readFile(input.configPath, "utf8"));
  const agent = JSON.parse(await fs.readFile(input.agentConfigPath, "utf8"));
  const providers = shared.providers;
  if (
    !providers
    || typeof providers !== "object"
    || Array.isArray(providers)
    || providers.defaultProviderId !== providerId
    || !Array.isArray(providers.items)
    || providers.items.length !== 1
  ) {
    throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_INVALID: shared.providers");
  }
  const selectedProvider = providers.items[0];
  if (
    !selectedProvider
    || typeof selectedProvider !== "object"
    || Array.isArray(selectedProvider)
    || selectedProvider.id !== providerId
    || selectedProvider.kind !== "codex-responses"
    || selectedProvider.model !== model
    || selectedProvider.baseUrl !== LOCKED_CODEX_RESPONSES_BASE_URL
    || selectedProvider.apiKeyEnv !== providerApiKeyEnv
    || selectedProvider.envFile !== "workspace/secrets/runtime.env"
  ) {
    throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_INVALID: shared.providers.items[0]");
  }
  if (Object.prototype.hasOwnProperty.call(agent, "providers")) {
    throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_INVALID: agent.providers");
  }
  const documents = [["shared", shared], ["agent", agent]];
  for (const [documentName, document] of documents) {
    const inlineSecretPath = findInlineSecretPath(document);
    if (inlineSecretPath) {
      throw new Error(
        `USER_TEST_PROVIDER_ROUTE_LOCK_INLINE_SECRET: ${documentName}.${inlineSecretPath}`
      );
    }
    for (const [routePath, valueKind] of PROVIDER_ROUTE_LOCK_FIELDS) {
      const expected = valueKind === "provider" ? providerId : model;
      if (readPath(document, routePath) !== expected) {
        throw new Error(`USER_TEST_PROVIDER_ROUTE_LOCK_INVALID: ${documentName}.${routePath}`);
      }
    }
  }
  const environmentText = await fs.readFile(input.envPath, "utf8");
  const environmentLines = environmentText.split(/\r?\n/u).filter(Boolean);
  const rawEnvironmentNames = environmentLines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line);
    return match?.[1];
  });
  const environment = dotenv.parse(environmentText);
  const environmentNames = Object.keys(environment).sort();
  const expectedEnvironmentNames = [providerApiKeyEnv, onebotAccessTokenEnv].sort();
  if (
    environmentLines.length !== expectedEnvironmentNames.length
    || rawEnvironmentNames.some((name) => !name)
    || new Set(rawEnvironmentNames).size !== rawEnvironmentNames.length
    || environmentNames.length !== expectedEnvironmentNames.length
    || environmentNames.some((name, index) => name !== expectedEnvironmentNames[index])
    || expectedEnvironmentNames.some((name) => !String(environment[name] ?? "").trim())
  ) {
    throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_INVALID: environment");
  }
}

export function providerRouteLockFieldPaths() {
  return PROVIDER_ROUTE_LOCK_FIELDS.map(([routePath]) => routePath);
}

function providerRouteLockOptions(options) {
  const providerId = optionalLockValue(options.providerId);
  const model = optionalLockValue(options.model);
  if (!options.lockProviderRoutes) {
    if (providerId || model) {
      throw new Error("USER_TEST_PROVIDER_ROUTE_LOCK_FLAG_REQUIRED");
    }
    return undefined;
  }
  return {
    providerId: requiredLockValue(providerId, "PROVIDER"),
    model: requiredLockValue(model, "MODEL")
  };
}

function requiredLockValue(value, label) {
  const text = optionalLockValue(value);
  if (!text) throw new Error(`USER_TEST_PROVIDER_ROUTE_LOCK_${label}_REQUIRED`);
  return text;
}

function optionalLockValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function applyProviderRouteLock(document, routeLock) {
  for (const [routePath, valueKind] of PROVIDER_ROUTE_LOCK_FIELDS) {
    writePath(
      document,
      routePath,
      valueKind === "provider" ? routeLock.providerId : routeLock.model
    );
  }
}

function stripInlineSecrets(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) stripInlineSecrets(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (INLINE_SECRET_FIELD_NAMES.has(key.toLowerCase())) {
      delete value[key];
      continue;
    }
    stripInlineSecrets(item);
  }
}

function findInlineSecretPath(value, prefix = "") {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findInlineSecretPath(
        value[index],
        prefix ? `${prefix}[${index}]` : `[${index}]`
      );
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, item] of Object.entries(value)) {
    const candidate = prefix ? `${prefix}.${key}` : key;
    if (INLINE_SECRET_FIELD_NAMES.has(key.toLowerCase())) return candidate;
    const found = findInlineSecretPath(item, candidate);
    if (found) return found;
  }
  return undefined;
}

function writePath(document, routePath, value) {
  const segments = routePath.split(".");
  let current = document;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = {};
    }
    current = current[segment];
  }
  current[segments.at(-1)] = value;
}

function readPath(document, routePath) {
  let current = document;
  for (const segment of routePath.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function resolveSourcePath(workspace, configured) {
  if (path.isAbsolute(configured)) return path.normalize(configured);
  const normalized = String(configured).replace(/\\/g, "/");
  if (normalized === ".env" || normalized === "workspace/.env") return path.join(workspace, ".env");
  if (normalized.startsWith("workspace/")) return path.join(workspace, normalized.slice("workspace/".length));
  return path.resolve(workspace, normalized);
}

async function assertEmptyOrMissing(directory) {
  try {
    const entries = await fs.readdir(directory);
    if (entries.length) throw new Error("隔离测试 workspace 必须不存在或为空。");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function assertDirectory(directory, label) {
  const stats = await fs.stat(directory);
  if (!stats.isDirectory()) throw new Error(`${label} 不是目录。`);
}

async function assertFileInside(filePath, root, label) {
  await assertPathInside(filePath, root, label);
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error(`${label} 不是文件。`);
}

async function copyValidatedCodexAuth(input) {
  const sourceContent = await readValidatedCodexAuth(
    input.source,
    "USER_TEST_CODEX_AUTH_SOURCE"
  );
  const destinationDirectory = path.join(
    input.destination,
    path.dirname(CODEX_AUTH_RELATIVE_PATH)
  );
  const destinationFile = path.join(input.destination, CODEX_AUTH_RELATIVE_PATH);
  await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(destinationDirectory, 0o700);
  await fs.writeFile(destinationFile, sourceContent, { mode: 0o600, flag: "wx" });
  await fs.chmod(destinationFile, 0o600);
  await assertCopiedCodexAuth(input);
}

async function prepareIsolatedCodexHome(input) {
  const destinationDirectory = path.join(
    input.destination,
    path.dirname(CODEX_AUTH_RELATIVE_PATH)
  );
  await fs.mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(destinationDirectory, 0o700);
  if (input.copyCodexAuth) {
    await copyValidatedCodexAuth(input);
    return;
  }
  await resolveValidatedCodexHome(input.destination, { codexAuthCopied: false });
}

async function readValidatedCodexAuth(root, errorPrefix, options = {}) {
  const codexHome = await resolveStandardCodexHome(root, errorPrefix);
  const filePath = path.join(root, CODEX_AUTH_RELATIVE_PATH);
  const expectedRealPath = path.join(codexHome, path.basename(CODEX_AUTH_RELATIVE_PATH));
  const fileStats = await fs.lstat(filePath).catch(() => {
    throw new Error(`${errorPrefix}_INVALID`);
  });
  if (!fileStats.isFile() || fileStats.isSymbolicLink() || fileStats.nlink !== 1) {
    throw new Error(`${errorPrefix}_INVALID`);
  }
  const realFilePath = await fs.realpath(filePath);
  if (path.normalize(realFilePath) !== path.normalize(expectedRealPath)) {
    throw new Error(`${errorPrefix}_INVALID`);
  }
  const handle = await fs.open(filePath, "r");
  try {
    const openedStats = await handle.stat();
    if (
      !openedStats.isFile()
      || openedStats.nlink !== 1
      || openedStats.dev !== fileStats.dev
      || openedStats.ino !== fileStats.ino
    ) {
      throw new Error(`${errorPrefix}_INVALID`);
    }
    if (
      options.requiredMode != null
      && (openedStats.mode & 0o777) !== options.requiredMode
    ) {
      throw new Error(`${errorPrefix}_INVALID`);
    }
    const content = await handle.readFile();
    assertCodexAuthDocument(content);
    return content;
  } finally {
    await handle.close();
  }
}

async function resolveStandardCodexHome(root, errorPrefix) {
  const realRoot = await fs.realpath(root);
  const relativeDirectory = path.dirname(CODEX_AUTH_RELATIVE_PATH);
  const directorySegments = relativeDirectory.split(path.sep);
  let directory = root;
  for (const segment of directorySegments) {
    directory = path.join(directory, segment);
    const stats = await fs.lstat(directory).catch(() => {
      throw new Error(`${errorPrefix}_INVALID`);
    });
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`${errorPrefix}_INVALID`);
    }
  }
  const realDirectory = await fs.realpath(directory);
  const expectedRealDirectory = path.join(realRoot, relativeDirectory);
  if (path.normalize(realDirectory) !== path.normalize(expectedRealDirectory)) {
    throw new Error(`${errorPrefix}_INVALID`);
  }
  return realDirectory;
}

function assertCodexAuthDocument(content) {
  let document;
  try {
    document = JSON.parse(content.toString("utf8"));
  } catch {
    throw new Error("USER_TEST_CODEX_AUTH_JSON_INVALID");
  }
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || !document.tokens
    || typeof document.tokens !== "object"
    || Array.isArray(document.tokens)
    || typeof document.tokens.access_token !== "string"
    || !document.tokens.access_token.trim()
  ) {
    throw new Error("USER_TEST_CODEX_AUTH_ACCESS_TOKEN_REQUIRED");
  }
}

async function assertPathInside(candidate, root, label) {
  const [realCandidate, realRoot] = await Promise.all([fs.realpath(candidate), fs.realpath(root)]);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} 不在源 workspace 内。`);
}

async function directoryExists(directory) {
  try {
    return (await fs.stat(directory)).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function requireAbsolute(value, name) {
  const text = String(value ?? "").trim();
  if (!path.isAbsolute(text)) throw new Error(`${name} 必须是绝对路径。`);
  return path.resolve(text);
}

function samePath(left, right) {
  return path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
}

function validAgentId(value) {
  const agentId = String(value ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(agentId)) {
    throw new Error("Agent ID 无效。");
  }
  return agentId;
}

function option(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  const next = index >= 0 ? process.argv[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await prepareProviderSmokeWorkspace({
    source: option("source"),
    destination: option("destination"),
    confirmCredentialCopy: process.argv.includes("--confirm-copy-provider-credential"),
    agentId: option("agent"),
    providerId: option("provider-id"),
    model: option("model"),
    lockProviderRoutes: process.argv.includes("--lock-provider-routes"),
    copyCodexAuth: process.argv.includes("--copy-codex-auth"),
    apiPort: Number(option("api-port") || 18_876)
  });
  console.log(`隔离 Provider workspace 已准备：${result.destination}`);
  console.log(`agent: ${result.agentId}`);
  console.log(`provider: ${result.provider.id} / ${result.provider.kind} / ${result.provider.model}`);
  console.log(`credential: configured (${result.provider.apiKeyEnv}); value hidden`);
}
