import { CronExpressionParser } from "cron-parser";
import { DREAM_SCHEDULE_CRON } from "../../services/memory/dream/public.js";

type JsonObject = Record<string, unknown>;

export interface DreamHistorySource {
  id: string;
  localDate: string;
  status: "running" | "generated" | "consolidated" | "completed" | "failed";
  dreamText: string | null;
  scheduledFor: string;
  completedAt: string | null;
  personaStatus: "pending" | "none" | "proposed" | "applied" | "skipped" | "failed";
  result: JsonObject | null;
}

export function dreamHistoryItem(run: DreamHistorySource) {
  const summary = dreamRunSummary(run.result);
  return {
    id: run.id,
    date: run.localDate,
    status: run.status === "consolidated" ? "generated" as const : run.status,
    ...(run.dreamText ? { dreamText: run.dreamText } : {}),
    scheduledFor: run.scheduledFor,
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    personalityChanged: run.personaStatus === "applied",
    ...(summary ? { summary } : {})
  };
}

export function dreamRunSummary(result: JsonObject | null) {
  if (!result) return undefined;
  const merged = nonNegativeNumber(result.merged);
  const archived = nonNegativeNumber(result.archived);
  const promoted = nonNegativeNumber(result.promoted);
  return merged == null || archived == null || promoted == null
    ? undefined
    : { merged, archived, promoted };
}

export function nextDreamScheduledAt(now: Date, timeZone: string) {
  return CronExpressionParser.parse(DREAM_SCHEDULE_CRON, { currentDate: now, tz: timeZone })
    .next().toDate().toISOString();
}

function nonNegativeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
