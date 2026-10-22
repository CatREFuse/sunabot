import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { remoteNapcatFile } from "./remoteNapcat.mjs";

export async function readNapcatDeviceIdentities(workspace, remote) {
  let source;
  try {
    source = await fs.readFile(path.join(workspace, "secrets/napcat-device-identities.json"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  return validateNapcatDeviceIdentities(JSON.parse(source), remote);
}

export function validateNapcatDeviceIdentities(value, remote) {
  if (value?.version !== 1 || !value.accounts || typeof value.accounts !== "object" || Array.isArray(value.accounts)) {
    throw new Error("NAPCAT_DEVICE_IDENTITY_CONFIG_INVALID");
  }
  const [subnet, prefix, extra] = String(value.network?.subnet ?? "").split("/");
  const gateway = value.network?.gateway;
  if (extra !== undefined || net.isIP(subnet) !== 4 || !/^(?:[1-9]|[12][0-9]|30)$/.test(prefix ?? "") || net.isIP(gateway ?? "") !== 4) {
    throw new Error("NAPCAT_DEVICE_IDENTITY_NETWORK_INVALID");
  }
  const number = (ip) => ip.split(".").reduce((result, part) => result * 256 + Number(part), 0);
  const network = number(subnet);
  const size = 2 ** (32 - Number(prefix));
  if (network % size !== 0 || number(gateway) <= network || number(gateway) >= network + size - 1
    || (remote && remote.gateway !== gateway)) {
    throw new Error("NAPCAT_DEVICE_IDENTITY_NETWORK_INVALID");
  }
  const macs = new Set();
  const addresses = new Set();
  for (const [accountId, device] of Object.entries(value.accounts)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(accountId)
      || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(device?.hostname ?? "")
      || !/^[a-f0-9]{32}$/.test(device?.machineId ?? "") || /^0+$/.test(device.machineId)
      || !/^(?:[a-fA-F0-9]{2}:){5}[a-fA-F0-9]{2}$/.test(device?.macAddress ?? "")
      || (parseInt(device.macAddress.slice(0, 2), 16) & 1) !== 0
      || device.macAddress === "00:00:00:00:00:00"
      || net.isIP(device?.ipv4Address ?? "") !== 4) {
      throw new Error(`NAPCAT_DEVICE_IDENTITY_INVALID: ${accountId}`);
    }
    if (number(device.ipv4Address) <= network || number(device.ipv4Address) >= network + size - 1
      || device.ipv4Address === gateway) {
      throw new Error(`NAPCAT_DEVICE_IDENTITY_NETWORK_INVALID: ${accountId}`);
    }
    const mac = device.macAddress.toLowerCase();
    if (macs.has(mac) || addresses.has(device.ipv4Address)) {
      throw new Error(`NAPCAT_DEVICE_IDENTITY_ADDRESS_CONFLICT: ${accountId}`);
    }
    macs.add(mac);
    addresses.add(device.ipv4Address);
  }
  return value;
}

export function napcatNetworkArguments(context) {
  const network = context.napcatDeviceIdentities?.network;
  if (network) return ["--subnet", network.subnet, "--gateway", network.gateway];
  const gateway = context.remoteNapcat?.gateway;
  return gateway ? ["--subnet", `${gateway.split(".").slice(0, 3).join(".")}.0/24`, "--gateway", gateway] : [];
}

export async function prepareNapcatDeviceIdentity(context, accountId) {
  const device = context.napcatDeviceIdentities?.accounts[accountId];
  if (!device) return [];
  const relative = `runtime/napcat/accounts/${accountId}/device-identity`;
  const remote = context.remoteNapcat;
  const directory = remote
    ? path.posix.join(remote.root, "workspace", relative)
    : path.join(context.workspace, relative);
  const machineIdName = `machine-id-${device.machineId}`;
  const machineIdPath = remote ? path.posix.join(directory, machineIdName) : path.join(directory, machineIdName);
  const composePath = remote ? path.posix.join(directory, "compose.json") : path.join(directory, "compose.json");
  const compose = JSON.stringify({ services: { napcat: {
    hostname: device.hostname,
    networks: { runtime: { mac_address: device.macAddress, ipv4_address: device.ipv4Address } },
    volumes: [{ type: "bind", source: machineIdPath, target: "/etc/machine-id", read_only: true,
      bind: { create_host_path: false } }]
  } } }, null, 2);
  if (remote) {
    await remoteNapcatFile(remote, `workspace/${relative}/${machineIdName}`, "write", `${device.machineId}\n`);
    await remoteNapcatFile(remote, `workspace/${relative}/compose.json`, "write", `${compose}\n`);
  } else {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [file, content] of [[machineIdPath, `${device.machineId}\n`], [composePath, `${compose}\n`]]) {
      const temporary = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, content, { mode: 0o600 });
      await fs.rename(temporary, file);
    }
  }
  return ["-f", composePath];
}
