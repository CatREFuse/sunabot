import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import {
  SCHEDULED_TASK_CATEGORIES,
  isDirectorScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskCategory,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
  type ScheduledTaskStore,
  type ScheduledTaskTarget
} from "../../services/scheduling/public.js";

const LIST_PAGE_SIZE = 100;

export interface ScheduledTaskAdminView {
  id: string;
  revision: number;
  name: string;
  enabled: boolean;
  context: string;
  schedule: ScheduledTaskSchedule;
  targets: ScheduledTaskTarget[];
  createdAt: string;
  updatedAt: string;
  nextTriggerAt?: string;
  lastTriggerAt?: string;
  lastRunStatus?: ScheduledTaskRun["status"];
  lastRunId?: string;
  deliveryAttempts?: number;
  nextDeliveryAt?: string;
  canReplayDelivery: boolean;
  lastError?: string;
  permanentRetention: boolean;
  archived: boolean;
  director: boolean;
}

export interface ScheduledTaskAdminPage {
  tasks: ScheduledTaskAdminView[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pageCount: number;
  };
}

export class ScheduledTaskAdminCatalog {
  constructor(private readonly store: ScheduledTaskStore) {}

  list(input: unknown = {}): ScheduledTaskAdminPage {
    this.store.purgeExpiredArchivedTasks();
    const page = this.store.listPage(scheduledTaskListInput(input));
    return {
      tasks: page.items.map((task) => this.view(task)),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        total: page.total,
        pageCount: page.pageCount
      }
    };
  }

  listAll(): ScheduledTaskAdminView[] {
    const tasks: ScheduledTask[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = this.store.list({ cursor, limit: LIST_PAGE_SIZE });
      tasks.push(...page.items);
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor)) throw new Error("Scheduled task pagination cursor repeated.");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    } while (cursor);
    return tasks.map((task) => this.view(task));
  }

  view(task: ScheduledTask): ScheduledTaskAdminView {
    const latest = this.store.listRuns(task.id).at(-1);
    return {
      id: task.id,
      revision: task.revision,
      name: task.name,
      enabled: task.enabled,
      context: task.context,
      schedule: structuredClone(task.schedule),
      targets: task.targets.map((target) => ({
        conversationId: target.conversationId,
        mentionUserIds: [...target.mentionUserIds]
      })),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.nextRunAt ? { nextTriggerAt: task.nextRunAt } : {}),
      ...(latest?.scheduledFor || task.lastScheduledAt
        ? { lastTriggerAt: latest?.scheduledFor ?? task.lastScheduledAt! }
        : {}),
      ...(latest ? { lastRunStatus: latest.status } : {}),
      ...(latest ? { lastRunId: latest.id, deliveryAttempts: latest.deliveryAttempts } : {}),
      ...(latest?.nextDeliveryAt ? { nextDeliveryAt: latest.nextDeliveryAt } : {}),
      ...(latest?.lastDeliveryError || latest?.errorText
        ? { lastError: latest.lastDeliveryError ?? latest.errorText! }
        : {}),
      canReplayDelivery: Boolean(
        latest?.status === "failed" && latest.resultText != null && latest.deliveryAttempts > 0
      ),
      permanentRetention: task.permanentRetention,
      archived: task.schedule.kind === "once" && task.nextRunAt === null &&
        (latest?.status === "completed" || latest?.status === "failed"),
      director: isDirectorScheduledTaskId(task.id)
    };
  }
}

function scheduledTaskListInput(value: unknown): {
  category: ScheduledTaskCategory;
  page: number;
  pageSize: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceError(400, "SCHEDULED_TASK_LIST_INVALID", "定时任务查询条件无效。");
  }
  const input = value as Record<string, unknown>;
  const unexpected = Object.keys(input).find((key) => !["category", "page", "pageSize"].includes(key));
  if (unexpected) {
    throw new ServiceError(400, "SCHEDULED_TASK_FIELD_UNSUPPORTED", `不支持字段：${unexpected}`, unexpected);
  }
  const category = input.category ?? "all";
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? 20;
  if (typeof category !== "string" || !SCHEDULED_TASK_CATEGORIES.includes(category as ScheduledTaskCategory)) {
    throw new ServiceError(400, "SCHEDULED_TASK_CATEGORY_INVALID", "定时任务分类无效。", "category");
  }
  if (!Number.isSafeInteger(page) || Number(page) < 1) {
    throw new ServiceError(400, "SCHEDULED_TASK_PAGE_INVALID", "page 必须是正整数。", "page");
  }
  if (!Number.isSafeInteger(pageSize) || Number(pageSize) < 1 || Number(pageSize) > 100) {
    throw new ServiceError(
      400,
      "SCHEDULED_TASK_PAGE_SIZE_INVALID",
      "pageSize 必须是 1 到 100 之间的整数。",
      "pageSize"
    );
  }
  return { category: category as ScheduledTaskCategory, page: Number(page), pageSize: Number(pageSize) };
}
