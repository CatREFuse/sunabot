import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const VERSION_TIMEOUT_MS = 15_000;
const CONVERSION_TIMEOUT_MS = 90_000;
const MAX_PROCESS_OUTPUT_CHARS = 64 * 1024;

export interface LibreOfficeInfo {
  executable: string;
  version: string;
}

export interface LibreOfficeConversion {
  outputPath: string;
  stdout: string;
  stderr: string;
}

export async function findLibreOffice(): Promise<LibreOfficeInfo | null> {
  const candidates = uniqueStrings([
    process.env.LIBREOFFICE_PATH,
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/opt/homebrew/bin/soffice",
    "/usr/local/bin/soffice",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice"
  ]);

  for (const executable of candidates) {
    try {
      await access(executable);
      const result = await runProcess(executable, ["--headless", "--version"], VERSION_TIMEOUT_MS);
      if (result.code !== 0) continue;
      const version = (result.stdout || result.stderr).trim();
      if (version) return { executable, version };
    } catch {
      // Try the next platform-specific location.
    }
  }
  return null;
}

export async function convertWithLibreOffice(
  inputPath: string,
  outputDir: string,
  outputFormat = "pdf",
  options: { executable?: string; timeoutMs?: number } = {}
): Promise<LibreOfficeConversion> {
  const info = options.executable
    ? { executable: options.executable }
    : await findLibreOffice();
  if (!info) throw new Error("LibreOffice is not installed.");

  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const profileRoot = await mkdtemp(path.join(outputDir, ".lo-profile-"));
  const expectedPath = path.join(
    outputDir,
    `${path.basename(inputPath, path.extname(inputPath))}.${sanitizeFormat(outputFormat)}`
  );

  try {
    const result = await runProcess(info.executable, [
      "--headless",
      "--nologo",
      "--nodefault",
      "--nofirststartwizard",
      "--norestore",
      `-env:UserInstallation=${pathToFileURL(profileRoot).href}`,
      "--convert-to",
      sanitizeFormat(outputFormat),
      "--outdir",
      outputDir,
      inputPath
    ], options.timeoutMs ?? CONVERSION_TIMEOUT_MS);

    if (result.code !== 0) {
      throw new Error(`LibreOffice conversion failed (${result.code}): ${result.stderr || result.stdout}`);
    }
    await access(expectedPath);
    await chmod(expectedPath, 0o600);
    return {
      outputPath: expectedPath,
      stdout: result.stdout,
      stderr: result.stderr
    };
  } finally {
    await rm(profileRoot, { recursive: true, force: true });
  }
}

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runProcess(executable: string, args: string[], timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, String(chunk));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`LibreOffice conversion timed out after ${timeoutMs}ms.`));
        return;
      }
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function sanitizeFormat(value: string) {
  const format = value.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(format)) throw new Error(`Invalid LibreOffice output format: ${value}`);
  return format;
}

function appendBounded(current: string, incoming: string) {
  if (current.length >= MAX_PROCESS_OUTPUT_CHARS) return current;
  return `${current}${incoming}`.slice(0, MAX_PROCESS_OUTPUT_CHARS);
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}
