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

export type ScheduledTaskCategory = "all" | "director" | "recurring" | "scheduled" | "archived";

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
  permanentRetention: boolean;
  archived: boolean;
  director: boolean;
  createdAt: string;
  updatedAt: string;
  nextTriggerAt?: string;
  lastTriggerAt?: string;
  lastRunStatus?: string;
  lastRunId?: string;
  deliveryAttempts?: number;
  nextDeliveryAt?: string;
  canReplayDelivery: boolean;
  lastError?: string;
}

export interface ScheduledTasksResponse {
  tasks: ScheduledTask[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  };
}

export interface ScheduledTaskConversationResponse {
  conversations: ConversationRecord[];
}

export type ScheduledTaskStatus =
  | { kind: "idle"; message: "" }
  | { kind: "success" | "error"; message: string };
