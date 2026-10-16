import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function readProcessSignature(pid, options = {}) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1) throw new Error("Invalid process PID.");
  if ((options.platform ?? process.platform) !== "linux") {
    const { stdout } = await (options.execFile ?? execFileAsync)("ps", ["-p", String(pid), "-o", "lstart="], {
      maxBuffer: 2 * 1024 * 1024
    });
    return String(stdout).trim();
  }

  const readFile = options.readFile ?? fs.readFile;
  const [bootId, stat] = await Promise.all([
    readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8")
  ]);
  return linuxProcessSignature(pid, bootId, stat);
}

export function linuxProcessSignature(pid, bootId, stat) {
  const boot = String(bootId).trim();
  const source = String(stat);
  const commEnd = source.lastIndexOf(")");
  const fields = source.slice(commEnd + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 1
    || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(boot)
    || !source.startsWith(`${pid} (`) || commEnd < source.indexOf("(")
    || !/^\d+$/u.test(startTicks ?? "")) {
    throw new Error("Invalid Linux process identity.");
  }
  return `linux:${boot}:${startTicks}`;
}
