import {
  formatModelTimestamp,
  systemModelTimeZone
} from "../../packages/platform/systemTime.js";

export { formatModelTimestamp, systemModelTimeZone };
const SYSTEM_TIME_ZONE_FALLBACK = "UTC";

export const DEFAULT_MODEL_TIME_CONTEXT = [
  "<time_context>当前系统时间与系统时区：@{runtime.current_time}。",
  "所有相对时间、日期、计划与时间判断都必须以该系统时间和系统时区为基准。",
  "输出时间或调用工具时必须携带 UTC 偏移或 IANA 时区，禁止使用无时区时间。</time_context>"
].join("");

export function formatModelCurrentTime(value: Date | string | number, timeZone = systemModelTimeZone()) {
  const zone = canonicalTimeZone(timeZone);
  return `${formatModelTimestamp(value, zone)} [system_timezone=${zone}]`;
}

export function formatOptionalModelTimestamp<T extends string | null | undefined>(
  value: T,
  timeZone = systemModelTimeZone()
): T | string {
  if (value == null || !Number.isFinite(Date.parse(value))) return value;
  return formatModelTimestamp(value, timeZone);
}

function canonicalTimeZone(value: string) {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return SYSTEM_TIME_ZONE_FALLBACK;
  }
}
