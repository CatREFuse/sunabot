import fs from "node:fs/promises";
import path from "node:path";
import type { McpSandboxProjection } from "./sandboxProjection.js";

interface ProjectionPathIdentity {
  canonicalPath: string;
  dev: string;
  ino: string;
  ctimeNs: string;
  size: string;
  mode: number;
  uid: string;
  kind: "directory" | "file";
  mutableDirectory: boolean;
}

export interface McpSandboxProjectionIdentity {
  paths: Record<string, ProjectionPathIdentity>;
}

export async function captureMcpSandboxProjectionIdentity(
  projection: McpSandboxProjection,
  options: { requireExecutableManifest: boolean }
): Promise<McpSandboxProjectionIdentity> {
  const candidates = projectionPaths(projection, options);
  const entries = await Promise.all(candidates.map(async ([name, file, expected, mutableDirectory]) => [
    name,
    await identity(file, expected, mutableDirectory)
  ] as const));
  return { paths: Object.fromEntries(entries) };
}

export async function assertMcpSandboxProjectionIdentity(
  projection: McpSandboxProjection,
  expected: McpSandboxProjectionIdentity,
  options: { requireExecutableManifest: boolean }
) {
  const current = await captureMcpSandboxProjectionIdentity(projection, options);
  const expectedNames = Object.keys(expected.paths).sort();
  const currentNames = Object.keys(current.paths).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(currentNames)) invalid();
  for (const name of expectedNames) {
    const before = expected.paths[name]!;
    const after = current.paths[name]!;
    if (before.canonicalPath !== after.canonicalPath || before.dev !== after.dev || before.ino !== after.ino
      || before.mode !== after.mode || before.uid !== after.uid || before.kind !== after.kind
      || (!before.mutableDirectory && (before.ctimeNs !== after.ctimeNs || before.size !== after.size))) {
      invalid();
    }
  }
}

function projectionPaths(
  projection: McpSandboxProjection,
  options: { requireExecutableManifest: boolean }
): Array<[string, string, { kind: "directory" | "file"; mode: number }, boolean]> {
  const launchSecrets = requiredPath(projection.launchSecrets);
  const stdioEntrypoint = requiredPath(projection.stdioEntrypoint);
  const values: Array<[string, string, { kind: "directory" | "file"; mode: number }, boolean]> = [
    ["root", projection.root, { kind: "directory", mode: 0o500 }, false],
    ["workbench", projection.workbench, { kind: "directory", mode: 0o700 }, false],
    ["skills", projection.skills, { kind: "directory", mode: 0o500 }, false],
    ["config-parent", path.dirname(projection.config), { kind: "directory", mode: 0o500 }, false],
    ["config", projection.config, { kind: "file", mode: 0o400 }, false],
    ["launch-secrets", launchSecrets, { kind: "directory", mode: 0o700 }, true],
    ["runtime-parent", path.dirname(stdioEntrypoint), { kind: "directory", mode: 0o500 }, false],
    ["stdio-entrypoint", stdioEntrypoint, { kind: "file", mode: 0o500 }, false]
  ];
  if (options.requireExecutableManifest) {
    values.push(["executable-manifest", requiredPath(projection.executableManifest), {
      kind: "file",
      mode: 0o444
    }, false]);
  }
  return values;
}

async function identity(
  file: string,
  expected: { kind: "directory" | "file"; mode: number },
  mutableDirectory: boolean
): Promise<ProjectionPathIdentity> {
  const resolved = path.resolve(requiredPath(file));
  const [canonicalPath, stat] = await Promise.all([
    fs.realpath(resolved),
    fs.lstat(resolved, { bigint: true })
  ]).catch(() => invalid());
  const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : undefined;
  if (stat.isSymbolicLink() || kind !== expected.kind || Number(stat.mode & 0o777n) !== expected.mode
    || (kind === "file" && stat.nlink !== 1n)) {
    invalid();
  }
  return {
    canonicalPath,
    dev: String(stat.dev),
    ino: String(stat.ino),
    ctimeNs: String(stat.ctimeNs),
    size: String(stat.size),
    mode: Number(stat.mode & 0o777n),
    uid: String(stat.uid),
    kind,
    mutableDirectory
  };
}

function requiredPath(value: string | undefined) {
  if (!value || !path.isAbsolute(value) || /[\u0000\r\n]/u.test(value)) invalid();
  return value;
}

function invalid(): never {
  const error = new Error("MCP_SANDBOX_PROJECTION_INVALID");
  error.name = "McpAdapterError";
  throw error;
}
