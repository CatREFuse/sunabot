import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { HardenedStdioLaunchSpec } from "./hardenedStdioTransport.js";
import type { McpSandboxProjection } from "./sandboxProjection.js";
import { mcpStdioEntrypointSource } from "./stdioEntrypointSource.js";
import {
  clearMcpStdioResolvedEnvironment,
  validateMcpStdioLaunchSpec
} from "./stdioLaunchPolicy.js";
import {
  captureIdentityBoundSecretDirectory,
  quarantineWipeAndRemove,
  wipeMcpSecretFile,
  type IdentityBoundSecretDirectory
} from "./secretProjectionCleanup.js";

export interface McpStdioLaunchProjection {
  agentId: string;
  serverId: string;
  hostDirectory: string;
  hostEntrypoint: string;
  digestSha256: string;
  identity: {
    directoryDev: string;
    directoryIno: string;
    directoryCtimeNs: string;
    fileName: string;
    fileDev: string;
    fileIno: string;
    fileCtimeNs: string;
    fileSize: string;
  };
  dispose(): Promise<void>;
}

export async function createMcpStdioLaunchProjection(input: {
  projection: McpSandboxProjection;
  spec: HardenedStdioLaunchSpec;
}): Promise<McpStdioLaunchProjection> {
  try {
    validateMcpStdioLaunchSpec(input.spec);
    const launchSecrets = requiredProjectionPath(input.projection.launchSecrets);
    const hostEntrypoint = requiredProjectionPath(input.projection.stdioEntrypoint);
    const nodeExecutable = input.projection.stdioNodeExecutable;
    if (nodeExecutable !== "/usr/bin/node" && nodeExecutable !== "/usr/local/bin/node") invalid();
    await assertPrivateDirectory(launchSecrets);
    await assertTrustedEntrypoint(hostEntrypoint, nodeExecutable);
    const config = await readBoundFile(input.projection.config, 1024 * 1024);
    const projectionDigestSha256 = createHash("sha256").update(config).digest("hex");
    if (projectionDigestSha256 !== input.projection.digestSha256) invalid();
    const configured = parseConfig(config);
    const secretValues = Object.values(input.spec.env);
    if (secretValues.some((value) => value.length === 0 || config.includes(value))) invalid();
    const envelope = {
      schemaVersion: 1,
      agentId: configured.agentId,
      serverId: configured.serverId,
      projectionDigestSha256,
      command: input.spec.command,
      args: [...input.spec.args],
      environment: sortRecord(input.spec.env)
    };
    const encoded = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    if (encoded.length > 1024 * 1024) invalid();
    const digestSha256 = createHash("sha256").update(encoded).digest("hex");
    const hostDirectory = path.join(launchSecrets, `launch-${randomBytes(16).toString("hex")}`);
    const file = path.join(hostDirectory, `${digestSha256}.json`);
    await fs.mkdir(hostDirectory, { mode: 0o700 });
    const cleanupIdentity = await captureIdentityBoundSecretDirectory(hostDirectory);
    let disposed = false;
    let cleanup: Promise<void> | undefined;
    try {
      const handle = await fs.open(file, "wx", 0o600);
      try {
        await handle.writeFile(encoded);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const [directoryStat, fileStat] = await Promise.all([
        fs.lstat(hostDirectory, { bigint: true }),
        fs.lstat(file, { bigint: true })
      ]);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o777n) !== 0o700n ||
          !fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1n ||
          (fileStat.mode & 0o777n) !== 0o600n || fileStat.size !== BigInt(encoded.length)) invalid();
      clearMcpStdioResolvedEnvironment(input.spec.env);
      const projection: McpStdioLaunchProjection = {
        agentId: configured.agentId,
        serverId: configured.serverId,
        hostDirectory,
        hostEntrypoint,
        digestSha256,
        identity: {
          directoryDev: String(directoryStat.dev),
          directoryIno: String(directoryStat.ino),
          directoryCtimeNs: String(directoryStat.ctimeNs),
          fileName: path.basename(file),
          fileDev: String(fileStat.dev),
          fileIno: String(fileStat.ino),
          fileCtimeNs: String(fileStat.ctimeNs),
          fileSize: String(fileStat.size)
        },
        async dispose() {
          if (disposed) return;
          encoded.fill(0);
          cleanup ??= (async () => {
            if (!cleanupIdentity.quarantinePath) await assertMcpStdioLaunchProjectionIdentity(projection);
            await clearAndRemovePrivateDirectory(cleanupIdentity, path.basename(file), {
              dev: fileStat.dev,
              ino: fileStat.ino,
              uid: fileStat.uid,
              size: fileStat.size
            });
          })().then(() => {
            disposed = true;
          }).catch(() => {
            cleanup = undefined;
            throw stableError("MCP_STDIO_SECRET_CLEANUP_FAILED");
          });
          await cleanup;
        }
      };
      return projection;
    } catch (error) {
      encoded.fill(0);
      await clearAndRemovePrivateDirectory(cleanupIdentity, path.basename(file)).catch(() => {
        throw stableError("MCP_STDIO_SECRET_CLEANUP_FAILED");
      });
      throw error;
    }
  } catch (error) {
    let resolvedError = error;
    try {
      clearMcpStdioResolvedEnvironment(input.spec.env);
    } catch (clearError) {
      resolvedError = clearError;
    }
    if (resolvedError instanceof Error && resolvedError.name === "McpAdapterError") throw resolvedError;
    throw stableError("MCP_STDIO_SECRET_PROJECTION_INVALID");
  }
}

export async function assertMcpStdioLaunchProjectionIdentity(projection: McpStdioLaunchProjection) {
  const entries = await fs.readdir(projection.hostDirectory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== projection.identity.fileName || !entries[0].isFile()) invalid();
  const file = path.join(projection.hostDirectory, projection.identity.fileName);
  const [directory, entry] = await Promise.all([
    fs.lstat(projection.hostDirectory, { bigint: true }),
    fs.lstat(file, { bigint: true })
  ]);
  if (!directory.isDirectory() || directory.isSymbolicLink() || Number(directory.mode & 0o777n) !== 0o700
    || String(directory.dev) !== projection.identity.directoryDev
    || String(directory.ino) !== projection.identity.directoryIno
    || String(directory.ctimeNs) !== projection.identity.directoryCtimeNs
    || !entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n
    || Number(entry.mode & 0o777n) !== 0o600
    || String(entry.dev) !== projection.identity.fileDev
    || String(entry.ino) !== projection.identity.fileIno
    || String(entry.ctimeNs) !== projection.identity.fileCtimeNs
    || String(entry.size) !== projection.identity.fileSize) {
    invalid();
  }
}

function parseConfig(encoded: Buffer) {
  let value: unknown;
  try {
    value = JSON.parse(encoded.toString("utf8"));
  } catch {
    invalid();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  const server = record.server;
  if (!/^[a-z][a-z0-9-]{1,31}$/u.test(String(record.agentId ?? "")) ||
      !server || typeof server !== "object" || Array.isArray(server) ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String((server as Record<string, unknown>).id ?? ""))) {
    invalid();
  }
  return {
    agentId: record.agentId as string,
    serverId: (server as Record<string, unknown>).id as string
  };
}

function requiredProjectionPath(value: string | undefined) {
  if (!value || !path.isAbsolute(value) || /[\u0000\r\n]/u.test(value)) invalid();
  return path.resolve(value);
}

async function assertPrivateDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700) invalid();
}

async function assertTrustedEntrypoint(file: string, nodeExecutable: "/usr/bin/node" | "/usr/local/bin/node") {
  const expected = Buffer.from(mcpStdioEntrypointSource(nodeExecutable), "utf8");
  const actual = await readBoundFile(file, 1024 * 1024);
  const stat = await fs.lstat(file);
  if ((stat.mode & 0o777) !== 0o500 || actual.length !== expected.length || !actual.equals(expected)) invalid();
}

async function readBoundFile(file: string, maximumBytes: number) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 ||
      before.size > maximumBytes) invalid();
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) invalid();
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) invalid();
    return content;
  } finally {
    await handle.close();
  }
}

function sortRecord(input: Readonly<Record<string, string>>) {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right, "en")));
}

async function clearAndRemovePrivateDirectory(
  identity: IdentityBoundSecretDirectory,
  fileName: string,
  expected?: { dev: bigint; ino: bigint; uid: bigint; size: bigint }
) {
  await quarantineWipeAndRemove(identity, async (directory) => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    if (entries.length > 1 || (entries.length === 1 &&
        (entries[0]!.name !== fileName || !entries[0]!.isFile() || entries[0]!.isSymbolicLink()))) {
      throw stableError("MCP_STDIO_SECRET_CLEANUP_FAILED");
    }
    if (!entries.length) return;
    const file = path.join(directory, fileName);
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n ||
        (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino || stat.uid !== expected.uid ||
          (stat.size !== expected.size && stat.size !== 0n)))) {
      throw stableError("MCP_STDIO_SECRET_CLEANUP_FAILED");
    }
    await wipeMcpSecretFile(file);
  });
}

function invalid(): never {
  throw stableError("MCP_STDIO_SECRET_PROJECTION_INVALID");
}

function stableError(code: string) {
  const error = new Error(code);
  error.name = "McpAdapterError";
  return error;
}
