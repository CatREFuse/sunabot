import type { ScheduledTaskSchedule } from "./schedule.js";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskTarget
} from "./scheduledTask.js";

export interface CreateScheduledTaskInput {
  id?: string;
  name: string;
  enabled?: boolean;
  schedule: ScheduledTaskSchedule;
  context: string;
  targets: ScheduledTaskTarget[];
}

export interface UpdateScheduledTaskInput {
  id: string;
  expectedRevision: number;
  name?: string;
  enabled?: boolean;
  schedule?: ScheduledTaskSchedule;
  context?: string;
  targets?: ScheduledTaskTarget[];
  permanentRetention?: boolean;
}

export const SCHEDULED_TASK_CATEGORIES = ["all", "director", "recurring", "scheduled", "archived"] as const;
export type ScheduledTaskCategory = (typeof SCHEDULED_TASK_CATEGORIES)[number];

export interface ListScheduledTasksInput {
  enabled?: boolean;
  cursor?: string;
  limit?: number;
}

export interface ScheduledTaskPage {
  items: ScheduledTask[];
  nextCursor: string | null;
}

export interface ListScheduledTaskPageInput {
  category: ScheduledTaskCategory;
  page: number;
  pageSize: number;
}

export interface ScheduledTaskOffsetPage {
  items: ScheduledTask[];
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface PurgeExpiredArchivedTasksInput {
  now?: Date;
}

export type UpdateScheduledTaskResult =
  | { status: "updated"; task: ScheduledTask }
  | { status: "conflict"; current: ScheduledTask }
  | { status: "not_found" };

export type DeleteScheduledTaskResult =
  | { status: "deleted" }
  | { status: "conflict"; current: ScheduledTask }
  | { status: "not_found" };

export interface ClaimDueOccurrenceInput {
  now?: Date;
}

export interface ClaimDueOccurrenceResult {
  status: "created" | "existing";
  run: ScheduledTaskRun;
}

export interface ClaimPendingRunInput {
  workerId: string;
  leaseMs: number;
  now?: Date;
}

export interface RenewScheduledTaskRunInput {
  runId: string;
  workerId: string;
  leaseMs: number;
  now?: Date;
}

export interface MarkScheduledTaskRunGeneratedInput {
  runId: string;
  workerId: string;
  resultText: string;
  now?: Date;
}

export interface CompleteScheduledTaskRunInput {
  runId: string;
  workerId: string;
  now?: Date;
}

export interface FailScheduledTaskRunInput {
  runId: string;
  workerId: string;
  errorText: string;
  now?: Date;
}

export interface ScheduledTaskStore {
  create(input: CreateScheduledTaskInput): ScheduledTask;
  get(id: string): ScheduledTask | undefined;
  list(input?: ListScheduledTasksInput): ScheduledTaskPage;
  listPage(input: ListScheduledTaskPageInput): ScheduledTaskOffsetPage;
  update(input: UpdateScheduledTaskInput): UpdateScheduledTaskResult;
  delete(id: string, expectedRevision: number): DeleteScheduledTaskResult;
  getRun(id: string): ScheduledTaskRun | undefined;
  listRuns(taskId?: string): ScheduledTaskRun[];
  claimDueOccurrence(input?: ClaimDueOccurrenceInput): ClaimDueOccurrenceResult | undefined;
  claimPendingRun(input: ClaimPendingRunInput): ScheduledTaskRun | undefined;
  renew(input: RenewScheduledTaskRunInput): ScheduledTaskRun | undefined;
  markGenerated(input: MarkScheduledTaskRunGeneratedInput): ScheduledTaskRun | undefined;
  complete(input: CompleteScheduledTaskRunInput): ScheduledTaskRun | undefined;
  fail(input: FailScheduledTaskRunInput): ScheduledTaskRun | undefined;
  purgeExpiredArchivedTasks(input?: PurgeExpiredArchivedTasksInput): number;
  nextWakeAt(): string | null;
}
