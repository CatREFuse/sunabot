import { applicationDataStore } from "../../adapters/sqlite/applicationDataStore.js";
import {
  DIRECTOR_DAILY_PLAN_PAYLOAD_VARIABLE,
  DIRECTOR_DAILY_PLAN_PROMPT_ID,
  DIRECTOR_SCHEDULE_REVISION_PAYLOAD_VARIABLE,
  DIRECTOR_SCHEDULE_REVISION_PROMPT_ID,
  DIRECTOR_SEED_VARIABLE,
  directorLocalDate,
  directorLocalHour,
  directorSchedulePromptContext,
  directorSeedHash,
  directorTimeZone,
  parseDirectorScheduleDraft,
  readDirectorSeed,
  type DirectorScheduleDraftV1,
  type DirectorScheduleItemV1,
  type DirectorScheduleV1
} from "../../services/director/public.js";
import type {
  CallDirectorToolInput,
  CallDirectorToolPort
} from "../../services/tools/callDirectorTool.js";
import {
  DIRECTOR_SCHEDULED_TASK_ID_PREFIX,
  type CreateScheduledTaskInput,
  type ScheduledTask,
  type ScheduledTaskTarget
} from "../../services/scheduling/public.js";
import { appendRequestLog } from "../../adapters/observability/requestLog.js";
import type { SunaRuntime } from "../runtime.js";
import {
  conversationReplyEnabled,
  isWebConversationId
} from "./messagingAttachmentHelpers.js";

const DIRECTOR_TICK_INTERVAL_MS = 60_000;
const DIRECTOR_WAKE_HOUR = 7;
const DIRECTOR_TARGET_CHUNK_SIZE = 20;

export class RuntimeDirector {
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<DirectorScheduleV1 | undefined>;

  constructor(private readonly host: SunaRuntime) {}

  start() {
    if (this.timer) return;
    void this.tick().catch((error) => this.logFailure("director.daily_plan.failed", error));
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.logFailure("director.daily_plan.failed", error));
    }, DIRECTOR_TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async promptContext(now = new Date()) {
    const store = applicationDataStore(this.host.config).director;
    return directorSchedulePromptContext(store.read(directorLocalDate(now, directorTimeZone())));
  }

  toolPort(): CallDirectorToolPort {
    return { execute: (input) => this.reviseToday(input) };
  }

  async ensureToday(now = new Date(), allowBeforeWake = false): Promise<DirectorScheduleV1 | undefined> {
    const timeZone = directorTimeZone();
    const date = directorLocalDate(now, timeZone);
    const store = applicationDataStore(this.host.config).director;
    const existing = store.read(date);
    if (existing) {
      await this.reconcileScheduledShares(existing, now);
      return existing;
    }
    if (!allowBeforeWake && directorLocalHour(now, timeZone) < DIRECTOR_WAKE_HOUR) return undefined;
    if (!this.inFlight) {
      this.inFlight = this.generateToday(now, date, timeZone).finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  private async tick() {
    await this.ensureToday(new Date());
  }

  private async generateToday(now: Date, date: string, timeZone: string) {
    const repository = applicationDataStore(this.host.config);
    const existing = repository.director.read(date);
    if (existing) return existing;
    const seed = await readDirectorSeed(this.host.config);
    const payload = {
      schemaVersion: 1,
      date,
      timeZone,
      weekday: new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(now),
      generatedAt: now.toISOString(),
      agent: {
        id: this.host.config.persona.defaultAgentId,
        name: this.host.config.persona.name
      },
      enabledConversations: this.enabledTargets().map((target) => target.conversationId)
    };
    const request = await this.host.renderPromptRequest(DIRECTOR_DAILY_PLAN_PROMPT_ID, {
      [DIRECTOR_SEED_VARIABLE]: seed,
      [DIRECTOR_DAILY_PLAN_PAYLOAD_VARIABLE]: payload
    });
    const text = await this.host.completePrompt(this.host.getProvider(), request, {
      logContext: {
        conversationId: `director:${this.host.config.persona.defaultAgentId}:${date}`,
        runId: `director-plan:${date}`,
        stage: "director",
        promptFamily: DIRECTOR_DAILY_PLAN_PROMPT_ID
      }
    });
    const draft = parseDirectorScheduleDraft(text, { date, timeZone });
    if (!draft.items.some((item) => item.share.enabled && Date.parse(item.share.at!) > now.getTime())) {
      throw new Error("Director daily plan must contain a future share.");
    }
    const committed = repository.director.commit({
      draft,
      seedHash: directorSeedHash(seed),
      source: "daily_plan",
      now
    });
    const schedule = committed.schedule;
    await this.reconcileScheduledShares(schedule, now);
    await appendRequestLog({
      category: "runtime.action",
      action: "director.daily_plan.committed",
      request: { date, timeZone },
      response: {
        revision: schedule.revision,
        itemCount: schedule.items.length,
        shareCount: schedule.items.filter((item) => item.share.enabled).length
      },
      metadata: {
        conversationId: `director:${this.host.config.persona.defaultAgentId}`,
        runId: `director-plan:${date}`,
        stage: "director"
      }
    });
    return schedule;
  }

  private async reviseToday(input: CallDirectorToolInput) {
    try {
      const now = new Date();
      const timeZone = directorTimeZone();
      const current = await this.ensureToday(now, true);
      if (!current) return { ok: false, code: "DIRECTOR_PLAN_UNAVAILABLE", error: "Today's schedule is unavailable." };
      const seed = await readDirectorSeed(this.host.config);
      const request = await this.host.renderPromptRequest(DIRECTOR_SCHEDULE_REVISION_PROMPT_ID, {
        [DIRECTOR_SEED_VARIABLE]: seed,
        [DIRECTOR_SCHEDULE_REVISION_PAYLOAD_VARIABLE]: {
          schemaVersion: 1,
          now: now.toISOString(),
          date: current.date,
          timeZone,
          request: input.request,
          currentSchedule: current
        }
      });
      const text = await this.host.completePrompt(this.host.getProvider(), request, {
        logContext: {
          conversationId: `director:${this.host.config.persona.defaultAgentId}:${current.date}`,
          runId: `director-revision:${current.date}:${current.revision + 1}`,
          stage: "director",
          promptFamily: DIRECTOR_SCHEDULE_REVISION_PROMPT_ID
        }
      });
      const draft = parseDirectorScheduleDraft(text, { date: current.date, timeZone });
      assertStartedItemsPreserved(current, draft, now);
      const repository = applicationDataStore(this.host.config);
      const committed = repository.director.commit({
        draft,
        seedHash: directorSeedHash(seed),
        source: "character_revision",
        requestText: input.request,
        expectedRevision: current.revision,
        now
      });
      if (committed.status === "conflict") {
        return {
          ok: false,
          code: "DIRECTOR_REVISION_CONFLICT",
          error: "Today's schedule changed while the director was working. Call the director again.",
          revision: committed.schedule.revision
        };
      }
      await this.reconcileScheduledShares(committed.schedule, now);
      await appendRequestLog({
        category: "runtime.action",
        action: "director.schedule.revised",
        request: { requestChars: input.request.length, previousRevision: current.revision },
        response: { revision: committed.schedule.revision },
        metadata: {
          conversationId: `director:${this.host.config.persona.defaultAgentId}`,
          runId: `director-revision:${current.date}:${committed.schedule.revision}`,
          stage: "director"
        }
      });
      return {
        ok: true,
        date: committed.schedule.date,
        revision: committed.schedule.revision,
        summary: committed.schedule.summary,
        remainingItems: committed.schedule.items.filter((item) => Date.parse(item.endAt) > now.getTime())
      };
    } catch (error) {
      await this.logFailure("director.schedule.revision_failed", error);
      return { ok: false, code: "DIRECTOR_REVISION_FAILED", error: errorMessage(error) };
    }
  }

  private async reconcileScheduledShares(schedule: DirectorScheduleV1, now: Date) {
    const repository = applicationDataStore(this.host.config);
    const links = repository.director.listTaskLinks(schedule.date);
    for (const link of links) {
      if (link.revision === schedule.revision) continue;
      const task = repository.scheduledTasks.get(link.taskId);
      if (task) deleteScheduledTask(repository.scheduledTasks, task);
      repository.director.deleteTaskLink(link.taskId);
    }

    const targets = this.enabledTargets();
    const targetChunks = chunk(targets, DIRECTOR_TARGET_CHUNK_SIZE);
    const desired: Array<{
      item: DirectorScheduleItemV1;
      runAt: string;
      draft: CreateScheduledTaskInput;
    }> = [];
    for (const item of schedule.items) {
      const runAt = item.share.at;
      if (!item.share.enabled || !runAt || Date.parse(runAt) <= now.getTime()) continue;
      for (const [chunkIndex, chunkTargets] of targetChunks.entries()) {
        const taskId = directorTaskId(
          this.host.config.persona.defaultAgentId,
          schedule,
          item,
          chunkIndex
        );
        desired.push({ item, runAt, draft: {
          id: taskId,
          name: `日常导演 · ${item.activity}`.slice(0, 120),
          enabled: true,
          schedule: { kind: "once", runAt },
          context: directorShareContext(this.host.config.persona.name, item),
          targets: chunkTargets
        } });
      }
    }
    const desiredIds = new Set(desired.map(({ draft }) => draft.id!));
    for (const link of links) {
      if (
        link.revision !== schedule.revision
        || Date.parse(link.runAt) <= now.getTime()
        || desiredIds.has(link.taskId)
      ) continue;
      const task = repository.scheduledTasks.get(link.taskId);
      if (task) deleteScheduledTask(repository.scheduledTasks, task);
      repository.director.deleteTaskLink(link.taskId);
    }
    for (const { item, runAt, draft } of desired) {
      const current = repository.scheduledTasks.get(draft.id!);
      if (current && !sameDirectorTaskDraft(current, draft)) {
        deleteScheduledTask(repository.scheduledTasks, current);
        repository.director.deleteTaskLink(current.id);
      }
      const task = repository.scheduledTasks.create(draft);
      repository.director.linkTask({
        scheduleDate: schedule.date,
        revision: schedule.revision,
        itemId: item.id,
        taskId: task.id,
        runAt,
        createdAt: now.toISOString()
      });
    }
    this.host.scheduledTasks.wake();
  }

  private enabledTargets(): ScheduledTaskTarget[] {
    return [...this.host.conversationRecords.values()]
      .filter((record) => !isWebConversationId(record.id) && conversationReplyEnabled(record))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => ({ conversationId: record.id, mentionUserIds: [] }));
  }

  private async logFailure(action: string, error: unknown) {
    await appendRequestLog({
      category: "runtime.error",
      action,
      request: {},
      response: { error: errorMessage(error) },
      metadata: {
        conversationId: `director:${this.host.config.persona.defaultAgentId}`,
        stage: "director"
      }
    }).catch(() => undefined);
  }
}

function directorTaskId(
  agentId: string,
  schedule: DirectorScheduleV1,
  item: DirectorScheduleItemV1,
  chunkIndex: number
) {
  const date = schedule.date.replaceAll("-", "");
  const agent = agentId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24) || "agent";
  const itemId = item.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48);
  return `${DIRECTOR_SCHEDULED_TASK_ID_PREFIX}${agent}-${date}-${itemId}-r${schedule.revision}-c${chunkIndex + 1}`
    .slice(0, 128);
}

function directorShareContext(
  agentName: string,
  item: DirectorScheduleItemV1
) {
  return [
    '<director_daily_share_output_contract version="2">',
    "这条消息只能是当前角色本人对刚发生或正在发生的小事进行自然分享，直接说日常内容，不解释此刻为什么发送。",
    "用户可见文字和自拍描述不得出现或暗示任何定时、计划、规划、日程、行程、安排、提醒、任务、触发、回调、cron、导演、系统、提示词、字段或预设等元信息。",
    "不要使用‘按照计划’‘今天安排’‘到点了’‘提醒一下’‘定时分享’等表达，也不要复述下面材料的字段名。",
    "必须调用 selfie 工具生成并发送一张现场自拍；自拍描述必须以 selfiePrompt 为主要依据，并保持当前角色外观与参考图一致。",
    "调用 selfie 前以及图片生成成功前不得发送任何用户可见消息；禁止调用 assistant_text，也不得提供 dispatch_message、进度、占位、预告或等待提示。",
    "图片生成成功后，只在最终回复中把简短文字、自拍和其他需发布内容一起提交，不得拆成多条或先发文字；图片生成失败时不要发送无图文字替代。",
    "文字保持简短，只表达角色此刻真正想分享的生活感受或现场细节。",
    "</director_daily_share_output_contract>",
    JSON.stringify({
      agentName,
      activity: item.activity,
      location: item.location,
      participants: item.participants,
      intent: item.intent,
      variant: item.variant,
      textIntent: item.share.textIntent,
      selfiePrompt: item.share.selfiePrompt
    })
  ].join("\n\n");
}

function assertStartedItemsPreserved(
  current: DirectorScheduleV1,
  draft: DirectorScheduleDraftV1,
  now: Date
) {
  const nextById = new Map(draft.items.map((item) => [item.id, item]));
  for (const item of current.items) {
    if (Date.parse(item.startAt) > now.getTime()) continue;
    const next = nextById.get(item.id);
    if (!next || JSON.stringify(next) !== JSON.stringify(item)) {
      throw new Error(`Director revision changed an item that already started: ${item.id}`);
    }
  }
}

function chunk<T>(items: readonly T[], size: number) {
  const values: T[][] = [];
  for (let index = 0; index < items.length; index += size) values.push(items.slice(index, index + size));
  return values;
}

function sameDirectorTaskDraft(task: ScheduledTask, draft: CreateScheduledTaskInput) {
  return task.name === draft.name
    && task.enabled === (draft.enabled ?? true)
    && task.schedule.kind === "once"
    && draft.schedule.kind === "once"
    && Date.parse(task.schedule.runAt) === Date.parse(draft.schedule.runAt)
    && task.context === draft.context
    && JSON.stringify(task.targets) === JSON.stringify(draft.targets);
}

function deleteScheduledTask(
  store: ReturnType<typeof applicationDataStore>["scheduledTasks"],
  task: ScheduledTask
) {
  const result = store.delete(task.id, task.revision);
  if (result.status === "conflict") {
    throw new Error(`Director scheduled task changed concurrently: ${task.id}`);
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : String(error || "Director failed.");
}
