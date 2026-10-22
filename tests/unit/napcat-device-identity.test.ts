// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readNapcatDeviceIdentities, validateNapcatDeviceIdentities, prepareNapcatDeviceIdentity, napcatNetworkArguments
} from "../../packages/platform/napcatDeviceIdentity.mjs";

const devices = () => ({ version: 1, network: { subnet: "172.30.77.0/24", gateway: "172.30.77.1" }, accounts: {
  primary: { hostname: "Fixture-PC", machineId: "1234567890abcdef1234567890abcdef", macAddress: "02:42:ac:1e:4d:02", ipv4Address: "172.30.77.2" },
  qq_Arona: { hostname: "Fixture-PC", machineId: "1234567890abcdef1234567890abcdef", macAddress: "02:42:ac:1e:4d:03", ipv4Address: "172.30.77.3" }
} });

describe("fixed NapCat device identity", () => {
  it.each([
    ["hostname", "a".repeat(64)], ["hostname", "-pc"], ["hostname", "pc\nOTHER=value"],
    ["machineId", "0".repeat(32)], ["machineId", "not-a-machine-id"],
    ["macAddress", "ff:ff:ff:ff:ff:ff"], ["macAddress", "00:00:00:00:00:00"], ["macAddress", "bad-mac"],
    ["ipv4Address", "not-an-address"], ["ipv4Address", "::1"]
  ])("rejects invalid execution parameter %s=%s", (key, value) => {
    const config = devices();
    Object.assign(config.accounts.primary, { [key]: value });
    expect(() => validateNapcatDeviceIdentities(config)).toThrow("NAPCAT_DEVICE_IDENTITY_INVALID");
  });

  it.each(["macAddress", "ipv4Address"] as const)("rejects two accounts sharing %s", (key) => {
    const config = devices();
    config.accounts.qq_Arona[key] = config.accounts.primary[key].toUpperCase();
    expect(() => validateNapcatDeviceIdentities(config)).toThrow("NAPCAT_DEVICE_IDENTITY_ADDRESS_CONFLICT");
  });

  it("keeps identical PC names with distinct network addresses and rejects invalid config/account paths", () => {
    expect(validateNapcatDeviceIdentities(devices())).toEqual(devices());
    expect(() => validateNapcatDeviceIdentities({ version: 2, accounts: {} })).toThrow("CONFIG_INVALID");
    expect(() => validateNapcatDeviceIdentities({ version: 1, accounts: [] })).toThrow("CONFIG_INVALID");
    expect(() => validateNapcatDeviceIdentities({ ...devices(), accounts: { "../escape": devices().accounts.primary } })).toThrow("IDENTITY_INVALID");
  });

  it("declares user-configured subnets for fixed local and remote IP addresses", () => {
    const config = devices();
    for (const remoteNapcat of [undefined, { gateway: "172.30.77.1" }]) {
      expect(validateNapcatDeviceIdentities(config, remoteNapcat)).toEqual(config);
      expect(napcatNetworkArguments({ napcatDeviceIdentities: config, remoteNapcat })).toEqual([
        "--subnet", "172.30.77.0/24", "--gateway", "172.30.77.1"
      ]);
    }
    expect(napcatNetworkArguments({})).toEqual([]);
    expect(napcatNetworkArguments({ remoteNapcat: { gateway: "172.30.77.1" } })).toEqual([
      "--subnet", "172.30.77.0/24", "--gateway", "172.30.77.1"
    ]);
    expect(() => validateNapcatDeviceIdentities(config, { gateway: "172.30.78.1" })).toThrow("NETWORK_INVALID");
  });

  it.each(["172.30.78.2", "172.30.77.1", "172.30.77.0", "172.30.77.255"])("rejects fixed IP outside the usable subnet: %s", (ipv4Address) => {
    const config = devices();
    config.accounts.primary.ipv4Address = ipv4Address;
    expect(() => validateNapcatDeviceIdentities(config)).toThrow("NETWORK_INVALID");
  });

  it.each(["172.30.77.1/24", "172.30.77.0/0", "172.30.77.0/33", "invalid/24", "172.30.77.0/24/extra"])("rejects invalid subnet %s", (subnet) => {
    const config = devices();
    config.network.subnet = subnet;
    expect(() => validateNapcatDeviceIdentities(config)).toThrow("NETWORK_INVALID");
  });

  it("reads private configuration, preserves QQ files, and creates repeatable Compose inputs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "sunabot-device-"));
    try {
      expect(await readNapcatDeviceIdentities(workspace)).toBeUndefined();
      expect(await prepareNapcatDeviceIdentity({ workspace }, "primary")).toEqual([]);
      await fs.mkdir(path.join(workspace, "secrets"));
      await fs.writeFile(path.join(workspace, "secrets/napcat-device-identities.json"), JSON.stringify(devices()));
      const config = await readNapcatDeviceIdentities(workspace);
      const context = { workspace, napcatDeviceIdentities: config };
      const qq = path.join(workspace, "runtime/napcat/accounts/primary/qq/global/nt_data/msf");
      await fs.mkdir(qq, { recursive: true });
      await fs.writeFile(path.join(qq, "machine-info"), "fixture-existing-qq-identity");
      const args = await prepareNapcatDeviceIdentity(context, "primary");
      const first = await fs.readFile(args[1], "utf8");
      expect(await prepareNapcatDeviceIdentity(context, "primary")).toEqual(args);
      expect(await fs.readFile(args[1], "utf8")).toBe(first);
      const compose = JSON.parse(first).services.napcat;
      expect(compose.hostname).toBe("Fixture-PC");
      expect(compose.networks.runtime).toEqual({ mac_address: config.accounts.primary.macAddress, ipv4_address: "172.30.77.2" });
      expect(compose.volumes[0]).toMatchObject({ target: "/etc/machine-id", read_only: true, bind: { create_host_path: false } });
      expect(await fs.readFile(compose.volumes[0].source, "utf8")).toBe(config.accounts.primary.machineId + "\n");
      const secondArgs = await prepareNapcatDeviceIdentity(context, "qq_Arona");
      const second = JSON.parse(await fs.readFile(secondArgs[1], "utf8")).services.napcat;
      expect(second.networks.runtime.mac_address).not.toBe(compose.networks.runtime.mac_address);
      expect(await fs.readFile(path.join(qq, "machine-info"), "utf8")).toBe("fixture-existing-qq-identity");
      config.accounts.primary.machineId = "fedcba0987654321fedcba0987654321";
      await prepareNapcatDeviceIdentity(context, "primary");
      const changed = JSON.parse(await fs.readFile(args[1], "utf8")).services.napcat;
      expect(changed.volumes[0].source).not.toBe(compose.volumes[0].source);
      expect(await fs.readFile(compose.volumes[0].source, "utf8")).toBe("1234567890abcdef1234567890abcdef\n");
      expect(await fs.readFile(changed.volumes[0].source, "utf8")).toBe("fedcba0987654321fedcba0987654321\n");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
