import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";

export async function readRemoteNapcat(workspace) {
  const file = path.join(workspace, "secrets/remote-napcat.json");
  let source;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  return validateRemoteNapcat(JSON.parse(source));
}

export function readRemoteNapcatSync(workspace) {
  let source;
  try {
    source = readFileSync(path.join(workspace, "secrets/remote-napcat.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  return validateRemoteNapcat(JSON.parse(source));
}

export function validateRemoteNapcat(value) {
  if (value?.version !== 1
    || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(value.host ?? "")
    || !/^[a-z_][a-z0-9_-]*$/.test(value.user ?? "")
    || value.user === "root"
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535
    || !Number.isInteger(value.uid) || value.uid <= 0
    || !Number.isInteger(value.gid) || value.gid <= 0
    || net.isIP(value.gateway) !== 4
    || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(value.gateway)
    || !/^\/[a-zA-Z0-9/_-]+$/.test(value.root ?? "")
    || value.root.split("/").includes("..")
    || value.root === "/"
    || !path.isAbsolute(value.identityFile ?? "")
    || !path.isAbsolute(value.knownHostsFile ?? "")) {
    throw new Error("REMOTE_NAPCAT_CONFIG_INVALID");
  }
  return value;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function offlineNapcatImage(indexBytes, manifestBytes, lockedImage, architecture) {
  const digest = (bytes) => `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
  if (digest(indexBytes) !== lockedImage.split("@")[1]) throw new Error("NAPCAT_OFFLINE_INDEX_MISMATCH");
  const index = JSON.parse(indexBytes.toString());
  const descriptor = index.manifests?.find((entry) =>
    entry.platform?.os === "linux" && entry.platform?.architecture === architecture);
  if (!descriptor || descriptor.digest !== digest(manifestBytes)) throw new Error("NAPCAT_OFFLINE_MANIFEST_MISMATCH");
  const manifest = JSON.parse(manifestBytes.toString());
  if (!/^sha256:[a-f0-9]{64}$/.test(manifest.config?.digest ?? "")) throw new Error("NAPCAT_OFFLINE_CONFIG_INVALID");
  return manifest.config.digest;
}

export function remoteSshArgs(remote) {
  return [
    "-T", "-p", String(remote.port),
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${remote.knownHostsFile}`,
    "-o", "IdentitiesOnly=yes", "-i", remote.identityFile,
    "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    `${remote.user}@${remote.host}`
  ];
}

export function remoteDockerInvocation(remote, args, environment = {}) {
  return {
    executable: "ssh",
    args: [...remoteSshArgs(remote), [
      "env",
      ...Object.entries(environment).map(([key, value]) => shellQuote(`${key}=${value}`)),
      "docker", ...args.map(shellQuote)
    ].join(" ")]
  };
}

// The request body travels over stdin, never through process arguments or logs.
const FILE_SCRIPT = `
import os, sys, json, base64, stat, shutil, re
r = json.load(sys.stdin)
p = r["path"]
root = os.path.realpath(r["root"])
if os.path.commonpath([root, os.path.realpath(p)]) != root:
    raise ValueError("REMOTE_NAPCAT_PATH_ESCAPE")
op = r["op"]
try:
    if op == "read":
        s = os.stat(p)
        if not stat.S_ISREG(s.st_mode): raise ValueError("REMOTE_NAPCAT_NOT_FILE")
        if s.st_size > 2097152: raise ValueError("REMOTE_NAPCAT_FILE_TOO_LARGE")
        with open(p, "rb") as f: data = f.read(2097153)
        print(json.dumps({"data": base64.b64encode(data).decode(), "mtimeMs": s.st_mtime_ns / 1000000, "size": len(data)}))
    elif op == "write":
        data = base64.b64decode(r["data"], validate=True)
        if len(data) > 2097152: raise ValueError("REMOTE_NAPCAT_FILE_TOO_LARGE")
        os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
        tmp = p + ".ssh-" + str(os.getpid())
        mode = r.get("mode", 0o600)
        if mode not in (0o600, 0o700): raise ValueError("REMOTE_NAPCAT_MODE_INVALID")
        fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
        print("{}")
    elif op == "remove":
        try: os.unlink(p)
        except FileNotFoundError: pass
        print("{}")
    elif op == "remove-account":
        relative = os.path.relpath(p, root)
        if not re.fullmatch(r"workspace/runtime/napcat/accounts/[a-zA-Z0-9_-]+", relative):
            raise ValueError("REMOTE_NAPCAT_ACCOUNT_PATH_INVALID")
        if os.path.islink(p): raise ValueError("REMOTE_NAPCAT_ACCOUNT_SYMLINK")
        if os.path.exists(p): shutil.rmtree(p)
        print("{}")
    else:
        raise ValueError("REMOTE_NAPCAT_OPERATION_INVALID")
except FileNotFoundError:
    print(json.dumps({"missing": True}))
`;

export async function remoteNapcatFile(remote, relative, op, data = undefined, mode = 0o600) {
  if (path.posix.isAbsolute(relative) || relative.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("REMOTE_NAPCAT_PATH_INVALID");
  }
  const request = {
    root: remote.root,
    path: path.posix.join(remote.root, relative),
    op,
    mode,
    ...(data !== undefined ? { data: Buffer.from(data).toString("base64") } : {})
  };
  const result = await new Promise((resolve, reject) => {
    const child = execFile("ssh", [
      ...remoteSshArgs(remote), `python3 -c ${shellQuote(FILE_SCRIPT)}`
    ], { timeout: 15_000, maxBuffer: 3 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin.on("error", reject);
    child.stdin.end(JSON.stringify(request));
  });
  const response = JSON.parse(result);
  return response.missing ? undefined : response;
}

export function remoteAccountPath(accountId, name) {
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId)) throw new Error("REMOTE_NAPCAT_ACCOUNT_INVALID");
  return `workspace/runtime/napcat/accounts/${accountId}/${name}`;
}

export function createRemoteLoginFiles(remote, accountId) {
  return {
    async read(name) {
      const result = await remoteNapcatFile(remote, remoteAccountPath(accountId, name), "read");
      return result ? { data: Buffer.from(result.data, "base64"), mtimeMs: result.mtimeMs } : undefined;
    },
    async write(name, data) {
      await remoteNapcatFile(remote, remoteAccountPath(accountId, name), "write", data);
    },
    async remove(name) {
      await remoteNapcatFile(remote, remoteAccountPath(accountId, name), "remove");
    }
  };
}
