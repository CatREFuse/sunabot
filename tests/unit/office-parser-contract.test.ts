// @vitest-environment node
import { describe, expect, it } from "vitest";
import componentLock from "../../components/component.lock.json";
import packageLock from "../../package-lock.json";
import packageManifest from "../../package.json";
import { validateOfficeParserContract } from "../../tooling/runtime/office-parser-contract.mjs";

describe("officeparser runtime contract", () => {
  it("binds the component lock to the exact package-lock version and integrity", () => {
    expect(validateOfficeParserContract({ componentLock, packageManifest, packageLock })).toEqual([]);
  });

  it("rejects forged officeparser integrity", () => {
    const drifted = structuredClone(packageLock) as typeof packageLock;
    drifted.packages["node_modules/officeparser"]!.integrity = `sha512-${"A".repeat(88)}`;

    expect(validateOfficeParserContract({
      componentLock,
      packageManifest,
      packageLock: drifted
    })).toContain("package-lock officeparser integrity must match the component lock");
  });

  it("rejects an officeparser lockfile version drift", () => {
    const drifted = structuredClone(packageLock) as typeof packageLock;
    drifted.packages["node_modules/officeparser"]!.version = "7.2.4";

    expect(validateOfficeParserContract({
      componentLock,
      packageManifest,
      packageLock: drifted
    })).toContain("package-lock officeparser version must match the component lock");
  });
});
