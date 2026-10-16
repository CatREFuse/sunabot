import path from "node:path";

export const NATIVE_TOOL_RESOURCE_LIMITS = Object.freeze([
  "--nproc=64:64",
  "--as=4294967296:4294967296",
  "--nofile=128:128",
  "--fsize=268435456:268435456",
  "--core=0:0"
]);

export const NATIVE_TOOL_CONFIG_DIRECTORIES = Object.freeze([
  "/etc/alternatives", "/etc/fonts", "/etc/libreoffice",
  "/etc/ImageMagick-6", "/etc/ImageMagick-7"
]);

export function nativeNodeRuntimeMounts(executable = process.execPath) {
  if (!path.posix.isAbsolute(executable)) return [];
  const bin = path.posix.dirname(executable);
  if (["/usr/bin", "/usr/local/bin", "/bin"].includes(bin)) return [];
  if (path.posix.basename(bin) !== "bin") {
    return ["--ro-bind", executable, "/usr/local/bin/node"];
  }
  const root = path.posix.dirname(bin);
  return ["--ro-bind", root, root];
}

export function nativeToolPath(executable = process.execPath) {
  const base = "/usr/local/bin:/usr/bin:/bin";
  return path.posix.isAbsolute(executable)
    ? `${path.posix.dirname(executable)}:${base}`
    : base;
}

/**
 * @param {{ workbenchRoot: string, environment: Readonly<Record<string, string>>,
 * executable?: string, resourceLimiter?: string, executionArguments: string[],
 * readOnlyMounts?: { skills: string, mcp: string }, outsideReadOnlyPaths?: string[],
 * networkAccess?: boolean }} input
 */
export function buildNativeBashSandboxInvocation(input) {
  const args = [
    "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid",
    "--unshare-uts", "--unshare-ipc", "--unshare-cgroup",
    "--uid", "0", "--gid", "0", "--cap-drop", "ALL",
    "--tmpfs", "/", "--proc", "/proc", "--dev", "/dev",
    "--dir", "/tmp", "--dir", "/etc", "--dir", "/workbench",
    "--dir", "/skills", "--dir", "/mcp"
  ];
  if (!input.networkAccess) args.splice(args.indexOf("--unshare-cgroup"), 0, "--unshare-net");
  for (const directory of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) {
    args.push("--dir", directory, "--ro-bind-try", directory, directory);
  }
  args.push(...nativeNodeRuntimeMounts());
  for (const directory of ["/etc/ssl", "/etc/ca-certificates", ...NATIVE_TOOL_CONFIG_DIRECTORIES]) {
    args.push("--ro-bind-try", directory, directory);
  }
  for (const file of [
    "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/passwd", "/etc/group", "/etc/localtime"
  ]) {
    args.push("--ro-bind-try", file, file);
  }
  args.push("--bind", input.workbenchRoot, "/workbench");
  if (input.readOnlyMounts) {
    args.push(
      "--ro-bind", input.readOnlyMounts.skills, "/skills",
      "--ro-bind", input.readOnlyMounts.mcp, "/mcp"
    );
  }
  for (const target of input.outsideReadOnlyPaths ?? []) {
    const parents = [];
    let current = path.posix.dirname(target);
    while (current !== "/" && current !== ".") {
      parents.push(current);
      current = path.posix.dirname(current);
    }
    for (const parent of parents.reverse()) args.push("--dir", parent);
    args.push("--ro-bind", target, target);
  }
  args.push("--chdir", "/workbench", "--clearenv");
  for (const [key, value] of Object.entries(input.environment)) args.push("--setenv", key, value);
  args.push(
    "--", input.resourceLimiter ?? "/usr/bin/prlimit", ...NATIVE_TOOL_RESOURCE_LIMITS,
    "--", ...input.executionArguments
  );
  return { file: input.executable ?? "/usr/bin/bwrap", args };
}
