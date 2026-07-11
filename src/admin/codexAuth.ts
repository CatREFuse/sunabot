import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const OUTPUT_LIMIT = 12_000;
const DEVICE_AUTH_DISCOVERY_MS = 5_000;

export interface CodexAuthSnapshot {
  installed: boolean;
  authenticated: boolean;
  method?: string;
  expiresAt?: string;
  login: {
    state: "idle" | "starting" | "waiting" | "succeeded" | "failed";
    verificationUrl?: string;
    userCode?: string;
    message?: string;
    startedAt?: string;
  };
}

export interface CodexAuthServiceOptions {
  codexHome: string;
  executable?: string;
}

export class CodexAuthService {
  private process?: ChildProcessWithoutNullStreams;
  private output = "";
  private login: CodexAuthSnapshot["login"] = { state: "idle" };

  constructor(private readonly options: CodexAuthServiceOptions) {}

  async status(): Promise<CodexAuthSnapshot> {
    const installed = await this.isInstalled();
    const auth = await this.readAuthSummary();
    return {
      installed,
      authenticated: auth.authenticated,
      ...(auth.method ? { method: auth.method } : {}),
      ...(auth.expiresAt ? { expiresAt: auth.expiresAt } : {}),
      login: { ...this.login }
    };
  }

  async startLogin(): Promise<CodexAuthSnapshot> {
    if (this.process && this.login.state !== "failed" && this.login.state !== "succeeded") {
      return this.status();
    }
    if (!(await this.isInstalled())) {
      this.login = { state: "failed", message: "Codex CLI 未安装或不可执行。" };
      return this.status();
    }

    await fs.mkdir(this.options.codexHome, { recursive: true, mode: 0o700 });
    await fs.chmod(this.options.codexHome, 0o700).catch(() => undefined);
    this.output = "";
    this.login = { state: "starting", startedAt: new Date().toISOString() };
    const child = spawn(this.executable(), ["login", "--device-auth"], {
      cwd: this.options.codexHome,
      env: { ...process.env, CODEX_HOME: this.options.codexHome },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.process = child;
    child.stdout.on("data", (chunk) => this.consumeOutput(String(chunk)));
    child.stderr.on("data", (chunk) => this.consumeOutput(String(chunk)));
    child.once("error", (error) => {
      this.login = { ...this.login, state: "failed", message: safeMessage(error.message) };
      this.process = undefined;
    });
    child.once("exit", (code) => {
      const authenticated = this.readAuthSummarySyncHint();
      this.login = authenticated || code === 0
        ? { ...this.login, state: "succeeded", message: "ChatGPT 订阅登录成功。" }
        : { ...this.login, state: "failed", message: safeMessage(lastUsefulLine(this.output) || `Codex 登录退出码 ${code ?? "unknown"}`) };
      this.process = undefined;
    });

    await Promise.race([
      waitFor(() => this.login.state !== "starting", DEVICE_AUTH_DISCOVERY_MS),
      new Promise((resolve) => setTimeout(resolve, DEVICE_AUTH_DISCOVERY_MS))
    ]);
    if (this.login.state === "starting") {
      this.login = { ...this.login, state: "waiting", message: "请在设备授权页面完成登录。" };
    }
    return this.status();
  }

  async logout(): Promise<CodexAuthSnapshot> {
    this.stopLogin();
    await runCommand(this.executable(), ["logout"], {
      ...process.env,
      CODEX_HOME: this.options.codexHome
    }).catch(async () => {
      await fs.rm(path.join(this.options.codexHome, "auth.json"), { force: true });
    });
    this.login = { state: "idle" };
    return this.status();
  }

  close() {
    this.stopLogin();
  }

  private stopLogin() {
    if (!this.process) return;
    this.process.kill("SIGTERM");
    this.process = undefined;
  }

  private consumeOutput(chunk: string) {
    this.output = `${this.output}${chunk}`.slice(-OUTPUT_LIMIT);
    const cleanOutput = stripVTControlCharacters(this.output);
    const verificationUrl = cleanOutput.match(/https:\/\/[^\s]+(?:device|activate)[^\s]*/i)?.[0]
      ?? cleanOutput.match(/https:\/\/auth\.openai\.com\/[^\s]+/i)?.[0];
    const userCode = cleanOutput.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/i)?.[0]
      ?? cleanOutput.match(/(?:code|代码)\s*[:：]?\s*([A-Z0-9]{4,})/i)?.[1];
    if (verificationUrl || userCode) {
      this.login = {
        ...this.login,
        state: "waiting",
        ...(verificationUrl ? { verificationUrl: trimPunctuation(verificationUrl) } : {}),
        ...(userCode ? { userCode } : {}),
        message: "请在设备授权页面完成登录。"
      };
    }
  }

  private async isInstalled() {
    return runCommand(this.executable(), ["--version"], process.env).then(() => true, () => false);
  }

  private executable() {
    return this.options.executable?.trim() || process.env.SUNABOT_CODEX_EXECUTABLE?.trim() || "codex";
  }

  private async readAuthSummary() {
    try {
      const payload = JSON.parse(await fs.readFile(path.join(this.options.codexHome, "auth.json"), "utf8")) as {
        auth_mode?: string;
        tokens?: { access_token?: string };
      };
      const claims = decodeJwt(payload.tokens?.access_token);
      const expiresAt = typeof claims?.exp === "number" ? new Date(claims.exp * 1000).toISOString() : undefined;
      const authenticated = Boolean(payload.tokens?.access_token) && (!expiresAt || Date.parse(expiresAt) > Date.now());
      return { authenticated, method: payload.auth_mode || "chatgpt", expiresAt };
    } catch {
      return { authenticated: false as const };
    }
  }

  private readAuthSummarySyncHint() {
    return this.login.state === "succeeded";
  }
}

function runCommand(executable: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { env, windowsHide: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`exit ${code ?? "unknown"}`)));
  });
}

function waitFor(predicate: () => boolean, timeoutMs: number) {
  return new Promise<void>((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!predicate() && Date.now() - startedAt < timeoutMs) return;
      clearInterval(timer);
      resolve();
    }, 50);
    timer.unref();
  });
}

function decodeJwt(token?: string) {
  try {
    const part = String(token ?? "").split(".")[1];
    if (!part) return undefined;
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
  } catch {
    return undefined;
  }
}

function lastUsefulLine(output: string) {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

function safeMessage(message: string) {
  return message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 300);
}

function trimPunctuation(value: string) {
  return value.replace(/[),.;]+$/, "");
}
