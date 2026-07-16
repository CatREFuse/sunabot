// @vitest-environment node
import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

const dockerfileUrl = new URL("../../deploy/docker/Dockerfile.bash", import.meta.url);
const composeUrl = new URL("../../deploy/docker/compose.bash.yml", import.meta.url);
const seccompUrl = new URL("../../deploy/docker/seccomp-bwrap.json", import.meta.url);
const policyUrl = new URL("../../services/tools/bashPolicy.ts", import.meta.url);

describe("Docker Bash image contract", () => {
  it("builds a separate pinned image with every fixed restricted executable", async () => {
    const dockerfile = await fs.readFile(dockerfileUrl, "utf8");
    const policy = await fs.readFile(policyUrl, "utf8");

    expect(dockerfile).toContain("node:24.18.0-bookworm-slim@sha256:");
    const fixedExecutables = new Set(policy.match(/\/usr\/bin\/[a-z0-9]+/g) ?? []);
    for (const checksum of ["md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum", "sha512sum"]) {
      fixedExecutables.add(`/usr/bin/${checksum}`);
    }
    expect(fixedExecutables.size).toBeGreaterThanOrEqual(30);
    for (const executable of ["/bin/bash", ...fixedExecutables]) {
      expect(dockerfile).toContain(executable);
    }
    expect(dockerfile).toContain('do test -x "$executable"; done');
    expect(dockerfile).toContain("/usr/bin/env /usr/bin/test");
    expect(dockerfile).toContain("WORKDIR /workbench");
    expect(dockerfile).toContain("USER 65534:65534");
    expect(dockerfile).not.toMatch(/^\s*(?:ADD|COPY)\s/im);
  });

  it("keeps image construction separate from Core and NapCat runtime services", async () => {
    const compose = await fs.readFile(composeUrl, "utf8");

    expect(compose).toContain("image: ${SUNABOT_BASH_IMAGE:-sunabot-bash:local}");
    expect(compose).toContain('profiles: ["build"]');
    expect(compose).toMatch(/^\s+context:\s+\.\s*$/m);
    expect(compose).toMatch(/^\s+dockerfile:\s+Dockerfile\.bash\s*$/m);
    expect(compose).not.toMatch(/^\s+context:\s+\.\.[/\\]?/m);
    expect(compose).toContain("network_mode: none");
    expect(compose).not.toContain("docker.sock");
    expect(compose).not.toMatch(/^\s+(?:core|napcat):/m);
  });

  it("allows only the exact bubblewrap clone namespace mask including network isolation", async () => {
    const profile = JSON.parse(await fs.readFile(seccompUrl, "utf8")) as {
      syscalls: Array<{
        names: string[];
        action: string;
        args?: Array<{ index: number; value: number; valueTwo?: number; op: string }>;
        comment?: string;
      }>;
    };
    const cloneRules = profile.syscalls.filter((rule) => rule.names.includes("clone"));
    const exactNamespaceRules = cloneRules.filter((rule) =>
      rule.args?.some((argument) => argument.valueTwo !== undefined)
    );

    expect(exactNamespaceRules).toHaveLength(1);
    expect(exactNamespaceRules[0]).toMatchObject({
      names: ["clone"],
      action: "SCMP_ACT_ALLOW",
      args: [{
        index: 0,
        value: 0x7e020080,
        valueTwo: 0x7e020000,
        op: "SCMP_CMP_MASKED_EQ"
      }]
    });
    expect(exactNamespaceRules[0]?.comment).toContain("net");
    expect(exactNamespaceRules[0]?.args?.[0]?.value).not.toBe(exactNamespaceRules[0]?.args?.[0]?.valueTwo);
    expect((exactNamespaceRules[0]?.args?.[0]?.value ?? 0) & 0x80).toBe(0x80);
    for (const rule of cloneRules.filter((candidate) => candidate !== exactNamespaceRules[0])) {
      for (const argument of rule.args ?? []) {
        expect(argument.value).toBe(0x7e020080);
        expect(argument.valueTwo).toBeUndefined();
      }
    }
  });
});
