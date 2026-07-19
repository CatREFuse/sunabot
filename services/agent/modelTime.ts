const SYSTEM_TIME_ZONE_FALLBACK = "UTC";

export const DEFAULT_MODEL_TIME_CONTEXT = [
  "<time_context>当前系统时间与系统时区：@{runtime.current_time}。",
  "所有相对时间、日期、计划与时间判断都必须以该系统时间和系统时区为基准。",
  "输出时间或调用工具时必须携带 UTC 偏移或 IANA 时区，禁止使用无时区时间。</time_context>"
].join("");

export function systemModelTimeZone() {
  const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
  if (!candidate) return SYSTEM_TIME_ZONE_FALLBACK;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return SYSTEM_TIME_ZONE_FALLBACK;
  }
}

export function formatModelTimestamp(value: Date | string | number, timeZone = systemModelTimeZone()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const zone = canonicalTimeZone(timeZone);
  const parts = dateTimeParts(date, zone);
  const offset = timeZoneOffset(date, zone, parts);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(date.getUTCMilliseconds()).padStart(3, "0")}${offset}`;
}

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

function dateTimeParts(date: Date, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!
  };
}

function timeZoneOffset(
  date: Date,
  timeZone: string,
  parts: ReturnType<typeof dateTimeParts>
) {
  const offsetName = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset"
  }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
  if (offsetName === "GMT") return "+00:00";
  const explicit = offsetName?.match(/^GMT([+-]\d{2}:\d{2})$/)?.[1];
  if (explicit) return explicit;

  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  const instantWithoutMilliseconds = date.getTime() - date.getUTCMilliseconds();
  const minutes = Math.round((localAsUtc - instantWithoutMilliseconds) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
