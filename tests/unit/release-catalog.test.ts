// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CURRENT_RELEASE_VERSION,
  RELEASE_CATALOG
} from "../../packages/platform/releaseCatalog.js";

describe("release catalog", () => {
  it("keeps the public, package and runtime versions aligned", () => {
    const packageManifest = readJson("package.json");
    const packageLock = readJson("package-lock.json");
    const runtimeContract = readJson("deploy/runtime-contract.json");

    expect(CURRENT_RELEASE_VERSION).toBe("0.1.0");
    expect(RELEASE_CATALOG.currentVersion).toBe(CURRENT_RELEASE_VERSION);
    expect(packageManifest.version).toBe(CURRENT_RELEASE_VERSION);
    expect(packageLock.version).toBe(CURRENT_RELEASE_VERSION);
    expect((packageLock.packages as Record<string, { version?: string }>)[""]?.version).toBe(CURRENT_RELEASE_VERSION);
    expect(runtimeContract.releaseVersion).toBe(CURRENT_RELEASE_VERSION);
  });

  it("publishes one unique current release with a dated changelog", () => {
    const versions = RELEASE_CATALOG.releases.map((release) => release.version);
    const current = RELEASE_CATALOG.releases.find((release) => release.version === CURRENT_RELEASE_VERSION);

    expect(new Set(versions).size).toBe(versions.length);
    expect(RELEASE_CATALOG.releases[0]?.version).toBe(CURRENT_RELEASE_VERSION);
    expect(current).toMatchObject({ releasedAt: "2026-07-22", title: "首次发布" });
    expect(current?.groups.map((group) => group.title)).toEqual(["核心能力", "稳定性", "管理台"]);
    expect(current?.groups.every((group) => group.items.length > 0)).toBe(true);
  });

  it("links the repository changelog and GitHub release", () => {
    const readme = readFileSync("README.md", "utf8");
    const changelog = readFileSync("CHANGELOG.md", "utf8");

    expect(readme).toContain("当前版本：`0.1.0`");
    expect(readme).toContain("[更新日志](CHANGELOG.md)");
    expect(changelog).toContain("## [0.1.0] - 2026-07-22");
    expect(changelog).toContain("releases/tag/v0.1.0");
    for (const group of RELEASE_CATALOG.releases[0]!.groups) {
      expect(changelog).toContain(`### ${group.title}`);
      for (const item of group.items) expect(changelog).toContain(`- ${item}`);
    }
  });
});

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
