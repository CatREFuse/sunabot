import { ServiceError } from "../../packages/contracts/errors/serviceError.js";
import {
  cronCreateInput,
  cronUpdateInput,
  type CronToolInput
} from "../../services/tools/cronTool.js";
import type { ParsedIncomingMessage } from "../types.js";
import { resolveScheduledTaskCurrentTargets } from "./scheduledTaskTargetResolver.js";

export interface ScheduledTaskToolOperations {
  create(input: unknown): unknown;
  get(id: string): unknown;
  list(): unknown;
  update(id: string, input: unknown): unknown;
  delete(id: string, input: unknown): unknown;
}

export async function executeScheduledTaskTool(
  input: CronToolInput,
  incoming: ParsedIncomingMessage,
  operations: ScheduledTaskToolOperations
) {
  try {
    const resolved = resolveScheduledTaskCurrentTargets(input, incoming);
    if (resolved.operation === "create") {
      return { ok: true, operation: "create", task: operations.create(cronCreateInput(resolved)) };
    }
    if (resolved.operation === "get") {
      return { ok: true, operation: "get", task: operations.get(resolved.taskId!) };
    }
    if (resolved.operation === "list") {
      return { ok: true, operation: "list", tasks: operations.list() };
    }
    if (resolved.operation === "update") {
      const update = cronUpdateInput(resolved);
      return {
        ok: true,
        operation: "update",
        task: operations.update(update.id, {
          revision: update.expectedRevision,
          ...(update.name == null ? {} : { name: update.name }),
          ...(update.enabled == null ? {} : { enabled: update.enabled }),
          ...(update.schedule == null ? {} : { schedule: update.schedule }),
          ...(update.context == null ? {} : { context: update.context }),
          ...(update.targets == null ? {} : { targets: update.targets })
        })
      };
    }
    return {
      ok: true,
      operation: "delete",
      result: operations.delete(resolved.taskId!, { revision: resolved.revision })
    };
  } catch (error) {
    if (error instanceof ServiceError) {
      return {
        ok: false,
        code: error.code,
        error: error.message,
        ...(error.latestRevision ? { latestRevision: error.latestRevision } : {})
      };
    }
    return {
      ok: false,
      code: "SCHEDULED_TASK_FAILED",
      error: scheduledTaskToolErrorMessage(error)
    };
  }
}

function scheduledTaskToolErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : String(error || "定时任务操作失败。");
}
