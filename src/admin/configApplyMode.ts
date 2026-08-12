import type { AppConfig } from "../types.js";

export const CONFIG_SECTIONS = [
  "server",
  "persona",
  "providers",
  "broadcastStorm",
  "normalReply",
  "bot",
  "tone",
  "memory",
  "director",
  "orchestrator",
  "tools",
  "bash",
  "onebot"
] as const;

export type ConfigSection = (typeof CONFIG_SECTIONS)[number];
export type ApplyMode = "hot" | "reconnect" | "restart";

export function sectionApplyMode(section: ConfigSection, before: AppConfig, after: AppConfig): ApplyMode {
  if (section === "server") return "restart";
  if (
    section === "tools" &&
    before.bot.tools.codex.maxConcurrency !== after.bot.tools.codex.maxConcurrency
  ) return "restart";
  if (section === "onebot" && before.onebot.reverseWsPath !== after.onebot.reverseWsPath) return "restart";
  if (section === "onebot" && before.onebot.accessTokenEnv !== after.onebot.accessTokenEnv) return "reconnect";
  return "hot";
}

export function restartRequiredFields(section: ConfigSection, before: AppConfig, after: AppConfig) {
  const fields: string[] = [];
  if (section === "server" && before.server.host !== after.server.host) fields.push("server.host");
  if (section === "server" && before.server.port !== after.server.port) fields.push("server.port");
  if (section === "onebot" && before.onebot.reverseWsPath !== after.onebot.reverseWsPath) {
    fields.push("onebot.reverseWsPath");
  }
  if (
    section === "tools" &&
    before.bot.tools.codex.maxConcurrency !== after.bot.tools.codex.maxConcurrency
  ) {
    fields.push("tools.codex.maxConcurrency");
  }
  return fields;
}
