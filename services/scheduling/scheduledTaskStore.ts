import type { ScheduledTaskSchedule } from "./schedule.js";
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskTarget
} from "./scheduledTask.js";

export interface CreateScheduledTaskInput {
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
}

export interface ListScheduledTasksInput {
  enabled?: boolean;
  cursor?: string;
  limit?: number;
}

export interface ScheduledTaskPage {
  items: ScheduledTask[];
  nextCursor: string | null;
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
  nextWakeAt(): string | null;
}
