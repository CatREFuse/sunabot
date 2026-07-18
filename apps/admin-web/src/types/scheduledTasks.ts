import type { ConversationRecord } from "../types";

export interface ScheduledTaskCronSchedule {
  kind: "cron";
  expression: string;
  timezone: string;
}

export interface ScheduledTaskOnceSchedule {
  kind: "once";
  runAt: string;
}

export type ScheduledTaskSchedule = ScheduledTaskCronSchedule | ScheduledTaskOnceSchedule;

export interface ScheduledTaskTarget {
  conversationId: string;
  mentionUserIds: string[];
}

export interface ScheduledTaskInput {
  name: string;
  enabled: boolean;
  context: string;
  schedule: ScheduledTaskSchedule;
  targets: ScheduledTaskTarget[];
}

export interface ScheduledTask extends ScheduledTaskInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  nextTriggerAt?: string;
  lastTriggerAt?: string;
  lastRunStatus?: string;
  lastError?: string;
}

export interface ScheduledTasksResponse {
  tasks: ScheduledTask[];
}

export interface ScheduledTaskConversationResponse {
  conversations: ConversationRecord[];
}

export type ScheduledTaskStatus =
  | { kind: "idle"; message: "" }
  | { kind: "success" | "error"; message: string };
