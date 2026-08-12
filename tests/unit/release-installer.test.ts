// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const installer = path.join(root, "install.sh");
const temporaryDirectories: string[] = [];
const version = "0.3.0";
const napcatVersion = "4.15.0";
const napcatRef = "docker.io/mlikiowa/napcat-docker:v4.15.0@sha256:cde89d766604e570517e9ce66304d4222210479d2209ec04e5d58890dea087f7";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("release installer", () => {
  it("has valid Bash syntax", () => {
    const result = spawnSync("/bin/bash", ["-n", installer], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["x86_64", "amd64"],
    ["aarch64", "arm64"]
  ])("installs the local Linux %s release as %s without pulling an existing NapCat image", async (machine, architecture) => {
    const fixture = await createInstallerFixture({ machine, architecture, imagePresent: true });

    const result = runInstaller(fixture);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const trace = await readTrace(fixture.trace);
    expect(trace).toContain(
      `curl:https://github.com/fixture/local/releases/download/v${version}/sunabot-${version}-linux-${architecture}.tar.gz`
    );
    expect(trace).toContain("node:version-smoke");
    expect(trace).toContain("node:release-integrity");
    expect(trace).toContain("node:dependency-smoke");
    expect(trace).toContain("node:codex-smoke");
    expect(trace).toContain("node:component-lock");
    expect(trace).toContain("bwrap:--version");
    expect(trace).toContain("lightpanda:telemetry=true:version");
    expect(trace).toContain(`docker:image inspect ${napcatRef}`);
    expect(trace.some((line) => line.startsWith("docker:pull "))).toBe(false);
    expect(trace).toContain(`bootstrap:workspace=${fixture.workspace}:bootstrap`);
    expect(trace.some((line) => line.startsWith("mv:-Tf -- "))).toBe(true);

    const target = await fs.readlink(path.join(fixture.prefix, "current"));
    expect(path.dirname(target)).toBe(path.join(fixture.prefix, "versions"));
    expect(path.basename(target)).toMatch(/^0\.3\.0-[a-f0-9]{16}-[A-Za-z0-9]+$/);
    await expect(fs.readFile(path.join(fixture.workspace, "bootstrap.marker"), "utf8"))
      .resolves.toBe(fixture.workspace);
    await expect(fs.access(path.join(target, "release-manifest.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(target, "workspace"))).rejects.toThrow();
  }, 15_000);

  it("atomically switches to a fresh same-version directory and pulls a missing NapCat image once", async () => {
    const fixture = await createInstallerFixture({
      machine: "x86_64",
      architecture: "amd64",
      imagePresent: false
    });

    const first = runInstaller(fixture);
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(first.stdout).toContain(`正在准备 NapCat ${napcatVersion} 运行镜像`);
    const firstTarget = await fs.readlink(path.join(fixture.prefix, "current"));
    await fs.writeFile(path.join(firstTarget, "sunabot.sh"), "#!/bin/sh\nexit 99\n");
    const second = runInstaller(fixture);

    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    const trace = await readTrace(fixture.trace);
    expect(trace.filter((line) => line === `docker:image inspect ${napcatRef}`)).toHaveLength(2);
    expect(trace.filter((line) => line === `docker:pull ${napcatRef}`)).toHaveLength(1);
    expect(trace.filter((line) => line === `bootstrap:workspace=${fixture.workspace}:bootstrap`)).toHaveLength(2);
    const secondTarget = await fs.readlink(path.join(fixture.prefix, "current"));
    expect(secondTarget).not.toBe(firstTarget);
    await expect(fs.readFile(path.join(secondTarget, "sunabot.sh"), "utf8"))
      .resolves.toContain("bootstrap:workspace");
  }, 30_000);

  it("rejects a mismatched release SHA before extraction and bootstrap", async () => {
    const fixture = await createInstallerFixture({
      machine: "x86_64",
      architecture: "amd64",
      imagePresent: true,
      invalidChecksum: true
    });

    const result = runInstaller(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("发行包 SHA-256 校验失败");
    const trace = await readTrace(fixture.trace);
    expect(trace.some((line) => line.startsWith("node:"))).toBe(false);
    expect(trace.some((line) => line.startsWith("bootstrap:"))).toBe(false);
    await expect(fs.access(path.join(fixture.prefix, "current"))).rejects.toThrow();
    await expect(fs.access(path.join(fixture.prefix, "versions"))).rejects.toThrow();
  }, 15_000);

  it("rejects an invalid release manifest before reading component locks or changing current", async () => {
    const fixture = await createInstallerFixture({
      machine: "x86_64",
      architecture: "amd64",
      imagePresent: true,
      invalidManifest: true
    });

    const result = runInstaller(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("发行包完整性校验失败");
    const trace = await readTrace(fixture.trace);
    expect(trace).toContain("node:release-integrity");
    expect(trace).not.toContain("node:component-lock");
    expect(trace.some((line) => line.startsWith("docker:image inspect "))).toBe(false);
    expect(trace.some((line) => line.startsWith("bootstrap:"))).toBe(false);
    await expect(fs.access(path.join(fixture.prefix, "current"))).rejects.toThrow();
  }, 15_000);
});

type InstallerFixture = {
  directory: string;
  prefix: string;
  workspace: string;
  trace: string;
  env: NodeJS.ProcessEnv;
};

async function createInstallerFixture(options: {
  machine: string;
  architecture: string;
  imagePresent: boolean;
  invalidChecksum?: boolean;
  invalidManifest?: boolean;
}): Promise<InstallerFixture> {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-release-installer-")));
  temporaryDirectories.push(directory);
  const releaseDirectory = path.join(directory, "release");
  const stage = path.join(directory, "archive-root");
  const fakeBin = path.join(directory, "bin");
  const prefix = path.join(directory, "installation");
  const workspace = path.join(prefix, "workspace");
  const trace = path.join(directory, "trace.log");
  const dockerState = path.join(directory, "docker-image-present");
  const temporaryRoot = path.join(directory, "tmp");
  await Promise.all([
    fs.mkdir(releaseDirectory, { recursive: true }),
    fs.mkdir(stage, { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
    fs.mkdir(temporaryRoot, { recursive: true }),
    fs.mkdir(path.join(directory, "home"), { recursive: true })
  ]);
  if (options.imagePresent) await fs.writeFile(dockerState, "present\n");

  await writeRelease(stage);
  const asset = `sunabot-${version}-linux-${options.architecture}.tar.gz`;
  const archive = path.join(releaseDirectory, asset);
  const tar = spawnSync("tar", ["-czf", archive, "-C", stage, "."], { encoding: "utf8" });
  if (tar.status !== 0) throw new Error(`fixture tar failed: ${tar.stderr}`);
  const checksum = options.invalidChecksum
    ? "0".repeat(64)
    : createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  await fs.writeFile(path.join(releaseDirectory, `${asset}.sha256`), `${checksum}  ${asset}\n`);

  await writeExecutable(path.join(fakeBin, "uname"), [
    "#!/bin/sh",
    "case \"${1:-}\" in",
    "  -s) printf '%s\\n' Linux ;;",
    `  -m) printf '%s\\n' ${options.machine} ;;`,
    "  *) exit 2 ;;",
    "esac"
  ]);
  await writeExecutable(path.join(fakeBin, "curl"), [
    "#!/bin/sh",
    "url=",
    "output=",
    "while [ \"$#\" -gt 0 ]; do",
    "  case \"$1\" in",
    "    https://*) url=$1 ;;",
    "    -o) shift; output=$1 ;;",
    "  esac",
    "  shift",
    "done",
    "printf 'curl:%s\\n' \"$url\" >> \"$INSTALL_TRACE\"",
    "file=${url##*/}",
    "exec /bin/cp \"$FAKE_RELEASE_DIR/$file\" \"$output\""
  ]);
  await writeExecutable(path.join(fakeBin, "docker"), [
    "#!/bin/sh",
    "printf 'docker:%s\\n' \"$*\" >> \"$INSTALL_TRACE\"",
    "case \"${1:-} ${2:-}\" in",
    "  'info ') exit 0 ;;",
    "  'compose version') exit 0 ;;",
    "  'image inspect') test -f \"$FAKE_DOCKER_STATE\" ;;",
    "  'pull '*) : > \"$FAKE_DOCKER_STATE\"; exit 0 ;;",
    "  *) exit 2 ;;",
    "esac"
  ]);
  await writeExecutable(path.join(fakeBin, "mv"), [
    "#!/bin/sh",
    "printf 'mv:%s\\n' \"$*\" >> \"$INSTALL_TRACE\"",
    "replace=0",
    "if [ \"${1:-}\" = '-Tf' ]; then replace=1; shift; fi",
    "if [ \"${1:-}\" = '--' ]; then shift; fi",
    "if [ \"$replace\" = '1' ]; then /bin/rm -f \"$2\"; fi",
    "exec /bin/mv -f \"$1\" \"$2\""
  ]);

  return {
    directory,
    prefix,
    workspace,
    trace,
    env: {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HOME: path.join(directory, "home"),
      TMPDIR: temporaryRoot,
      SUNABOT_GITHUB_REPOSITORY: "fixture/local",
      SUNABOT_VERSION: version,
      SUNABOT_INSTALL_PREFIX: prefix,
      FAKE_RELEASE_DIR: releaseDirectory,
      FAKE_DOCKER_STATE: dockerState,
      FAKE_INVALID_MANIFEST: options.invalidManifest ? "1" : "0",
      INSTALL_TRACE: trace
    }
  };
}

async function writeRelease(stage: string) {
  await Promise.all([
    writeExecutable(path.join(stage, "runtime/node/bin/node"), [
      "#!/bin/sh",
      "case \"$*\" in",
      "  *process.versions.node*) printf '%s\\n' 'node:version-smoke' >> \"$INSTALL_TRACE\"; exit 0 ;;",
      "  *validateReleaseManifest*) printf '%s\\n' 'node:release-integrity' >> \"$INSTALL_TRACE\"; test \"${FAKE_INVALID_MANIFEST:-0}\" != '1' ;;",
      "  *Promise.all*) printf '%s\\n' 'node:dependency-smoke' >> \"$INSTALL_TRACE\"; exit 0 ;;",
      "  *codex.js*--version*) printf '%s\\n' 'node:codex-smoke' >> \"$INSTALL_TRACE\"; printf '%s\\n' 'codex-cli 0.139.0'; exit 0 ;;",
      `  *component.lock.json*) printf '%s\\n' 'node:component-lock' >> \"$INSTALL_TRACE\"; printf '%s\\n%s' '${napcatVersion}' '${napcatRef}'; exit 0 ;;`,
      "  *) exit 2 ;;",
      "esac"
    ]),
    writeExecutable(path.join(stage, "runtime/bubblewrap/bwrap"), [
      "#!/bin/sh",
      "printf 'bwrap:%s\\n' \"$*\" >> \"$INSTALL_TRACE\"",
      "test \"${1:-}\" = '--version'"
    ]),
    writeExecutable(path.join(stage, "runtime/lightpanda/lightpanda"), [
      "#!/bin/sh",
      "printf 'lightpanda:telemetry=%s:%s\\n' \"${LIGHTPANDA_DISABLE_TELEMETRY:-}\" \"$*\" >> \"$INSTALL_TRACE\"",
      "test \"${1:-}\" = 'version'"
    ]),
    writeExecutable(path.join(stage, "sunabot.sh"), [
      "#!/bin/sh",
      "printf 'bootstrap:workspace=%s:%s\\n' \"${SUNABOT_WORKSPACE:-}\" \"$*\" >> \"$INSTALL_TRACE\"",
      "test \"${1:-}\" = 'bootstrap'",
      "printf '%s' \"$SUNABOT_WORKSPACE\" > \"$SUNABOT_WORKSPACE/bootstrap.marker\""
    ]),
    writeFile(path.join(stage, "release-manifest.json"), "{}\n"),
    writeFile(path.join(stage, "components/component.lock.json"), `${JSON.stringify({
      components: {
        napcat: {
          version: napcatVersion,
          image: "docker.io/mlikiowa/napcat-docker:v4.15.0",
          digest: "sha256:cde89d766604e570517e9ce66304d4222210479d2209ec04e5d58890dea087f7"
        }
      }
    })}\n`)
  ]);
}

function runInstaller(fixture: InstallerFixture) {
  return spawnSync("/bin/bash", [installer], {
    cwd: fixture.directory,
    encoding: "utf8",
    timeout: 15_000,
    env: fixture.env
  });
}

async function readTrace(trace: string) {
  return (await fs.readFile(trace, "utf8")).trim().split("\n");
}

async function writeExecutable(target: string, lines: string[]) {
  await writeFile(target, `${lines.join("\n")}\n`, 0o755);
}

async function writeFile(target: string, contents: string, mode = 0o644) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, { mode });
}
