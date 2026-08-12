import type {
  ScheduledTaskCronSchedule,
  ScheduledTaskSchedule
} from "../../types/scheduledTasks";

export type CronPresetKind = "interval" | "hourly" | "daily" | "weekly" | "monthly";

export interface CronPresetDraft {
  kind: CronPresetKind;
  interval: number;
  minute: number;
  hour: number;
  weekDay: number;
  monthDay: number;
}

export const MAX_SCHEDULED_TASK_MENTIONS = 20;

const DEFAULT_PRESET: CronPresetDraft = {
  kind: "daily",
  interval: 15,
  minute: 0,
  hour: 9,
  weekDay: 1,
  monthDay: 1
};

export function defaultTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
}

export function defaultCronSchedule(): ScheduledTaskCronSchedule {
  return { kind: "cron", expression: "0 9 * * *", timezone: defaultTimezone() };
}

export function defaultOnceSchedule(): ScheduledTaskSchedule {
  const runAt = new Date(Date.now() + 60 * 60 * 1000);
  runAt.setSeconds(0, 0);
  return { kind: "once", runAt: runAt.toISOString() };
}

export function buildCronExpression(draft: CronPresetDraft) {
  const minute = integerWithin(draft.minute, 0, 59, 0);
  const hour = integerWithin(draft.hour, 0, 23, 9);
  if (draft.kind === "interval") {
    return `*/${integerWithin(draft.interval, 1, 59, 15)} * * * *`;
  }
  if (draft.kind === "hourly") return `${minute} * * * *`;
  if (draft.kind === "weekly") {
    return `${minute} ${hour} * * ${integerWithin(draft.weekDay, 0, 6, 1)}`;
  }
  if (draft.kind === "monthly") {
    return `${minute} ${hour} ${integerWithin(draft.monthDay, 1, 31, 1)} * *`;
  }
  return `${minute} ${hour} * * *`;
}

export function parseCronPreset(expression: string): CronPresetDraft | null {
  const value = expression.trim().replace(/\s+/g, " ");
  let match = value.match(/^\*\/(\d{1,2}) \* \* \* \*$/);
  if (match && within(match[1], 1, 59)) {
    return { ...DEFAULT_PRESET, kind: "interval", interval: Number(match[1]) };
  }
  match = value.match(/^(\d{1,2}) \* \* \* \*$/);
  if (match && within(match[1], 0, 59)) {
    return { ...DEFAULT_PRESET, kind: "hourly", minute: Number(match[1]) };
  }
  match = value.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (match && within(match[1], 0, 59) && within(match[2], 0, 23)) {
    return { ...DEFAULT_PRESET, kind: "daily", minute: Number(match[1]), hour: Number(match[2]) };
  }
  match = value.match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/);
  if (match && within(match[1], 0, 59) && within(match[2], 0, 23)) {
    return {
      ...DEFAULT_PRESET,
      kind: "weekly",
      minute: Number(match[1]),
      hour: Number(match[2]),
      weekDay: Number(match[3])
    };
  }
  match = value.match(/^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/);
  if (
    match
    && within(match[1], 0, 59)
    && within(match[2], 0, 23)
    && within(match[3], 1, 31)
  ) {
    return {
      ...DEFAULT_PRESET,
      kind: "monthly",
      minute: Number(match[1]),
      hour: Number(match[2]),
      monthDay: Number(match[3])
    };
  }
  return null;
}

export function cronExpressionError(expression: string) {
  const value = expression.trim();
  if (!value) return "请输入 Cron 表达式";
  if (value.length > 128) return "Cron 表达式不能超过 128 个字符";
  if (value.split(/\s+/).length !== 5) return "Cron 表达式需包含分、时、日、月、周 5 段";
  if (/[^\d*/?,\-\sA-Za-z#L]/.test(value)) return "Cron 表达式包含无效字符";
  return "";
}

export function describeSchedule(schedule: ScheduledTaskSchedule) {
  if (schedule.kind === "once") return `单次 · ${formatDateTime(schedule.runAt)}`;
  const preset = parseCronPreset(schedule.expression);
  const zone = schedule.timezone ? ` · ${schedule.timezone}` : "";
  if (!preset) return `Cron ${schedule.expression}${zone}`;
  if (preset.kind === "interval") return `每 ${preset.interval} 分钟${zone}`;
  if (preset.kind === "hourly") return `每小时 ${pad(preset.minute)} 分${zone}`;
  const time = `${pad(preset.hour)}:${pad(preset.minute)}`;
  if (preset.kind === "weekly") return `每周${weekDayLabel(preset.weekDay)} ${time}${zone}`;
  if (preset.kind === "monthly") return `每月 ${preset.monthDay} 日 ${time}${zone}`;
  return `每天 ${time}${zone}`;
}

export function formatDateTime(value: string | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

export function toDateTimeLocal(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function fromDateTimeLocal(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function isGroupConversationId(value: string) {
  return /^(?:account:[A-Za-z0-9_-]+:)?group:\d+$/.test(value.trim());
}

export function validConversationId(value: string) {
  return /^(?:account:[A-Za-z0-9_-]+:)?(?:private|group):\d+$/.test(value.trim());
}

export function validMentionUserId(value: string) {
  const userId = value.trim();
  if (!/^[1-9]\d*$/.test(userId)) return false;
  try {
    return BigInt(userId) <= BigInt(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

function weekDayLabel(value: number) {
  return ["日", "一", "二", "三", "四", "五", "六"][value] ?? String(value);
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function within(value: string | undefined, min: number, max: number) {
  if (value == null) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

function integerWithin(value: number, min: number, max: number, fallback: number) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
