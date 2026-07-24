import { createHash, randomUUID } from "node:crypto";
import {
  dreamPersonaPromptVariables,
  projectDreamContextPayload
} from "./dreamContextProjection.js";
import {
  dreamHistoryItem,
  dreamRunSummary,
  nextDreamScheduledAt
} from "./dreamHistory.js";
import { assertDreamProviderRequest } from "./dreamProviderRequest.js";
import { commitDreamWithWorkingMemory, type RuntimeDreamWorkingMemoryPort } from "./dreamWorkingMemoryCommit.js";
import type { RuntimeDreamContextPort, RuntimeDreamContextSnapshot, RuntimeDreamPromptPort } from "./dreamPorts.js";
export type { RuntimeDreamWorkingMemoryPort } from "./dreamWorkingMemoryCommit.js";
export type { RuntimeDreamContextPort, RuntimeDreamContextSnapshot, RuntimeDreamPromptPort } from "./dreamPorts.js";
import {
  DREAM_PAYLOAD_VARIABLE,
  DREAM_PROMPT_ID,
  buildPersonaEvidence,
  buildDreamConsolidationPlan,
  composeDreamRecallLineages,
  dreamLocalDate,
  dreamSystemTimeZone,
  evaluateDreamPersonaAdjustment,
  latestDreamScheduleOccurrence,
  normalizeDreamMemorySnapshot,
  normalizeDreamModelOutput,
  parseDreamModelOutput,
  selectDreamMemories,
  type DreamMemorySelectionSettings, type DreamMemoryRecord,
  type DreamModelOutputV1,
  type DreamPersonaAdjustmentV1,
  type DreamRecallStatsSnapshot,
  type DreamScheduleOccurrence
} from "../../services/memory/dream/public.js";
const DREAM_TICK_INTERVAL_MS = 60_000;
const DREAM_LEASE_MS = 45 * 60_000;
const DREAM_RETRY_DELAY_MS = 15 * 60_000;
const DREAM_MAX_ATTEMPTS = 3;
const DREAM_HISTORY_LIMIT = 30;
const PERSONA_SECTION = "## 缓慢形成的倾向";
type JsonObject = Record<string, unknown>;
export type RuntimeDreamRunStatus = "running" | "generated" | "consolidated" | "completed" | "failed";
export type RuntimeDreamPersonaStatus = "pending" | "none" | "proposed" | "applied" | "skipped" | "failed";
export interface RuntimeDreamRun {
  id: string;
  localDate: string;
  scheduledFor: string;
  timeZone: string;
  window: { start: string; end: string };
  status: RuntimeDreamRunStatus;
  workerId: string | null;
  leaseUntil: string | null;
  attemptCount: number;
  seed: string;
  inputDigest: string;
  input: JsonObject;
  output: JsonObject | null;
  dreamText: string | null;
  workingMemoryId: string | null;
  persona: JsonObject | null;
  personaStatus: RuntimeDreamPersonaStatus;
  result: JsonObject | null;
  errorCode: string | null;
  errorText: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  updatedAt: string;
  generatedAt: string | null;
  consolidatedAt: string | null;
  personaUpdatedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}
export interface RuntimeDreamStorePort {
  purgeArchivedMemories?(input?: { now?: Date; limit?: number }): unknown[];
  getRunByLocalDate(localDate: string): RuntimeDreamRun | undefined;
  listRuns(input?: { beforeLocalDate?: string; limit?: number }): RuntimeDreamRun[];
  claimDailyRun(input: {
    id?: string;
    localDate: string;
    scheduledFor: string;
    timeZone: string;
    window: { start: string; end: string };
    workerId: string;
    leaseMs: number;
    seed: string;
    inputDigest: string;
    input: JsonObject;
    force?: boolean;
    now?: Date;
  }): { status: "created" | "recovered" | "busy" | "existing"; run: RuntimeDreamRun };
  markGenerated(input: {
    runId: string;
    workerId: string;
    output: JsonObject;
    dreamText: string;
    now?: Date;
  }): RuntimeDreamRun | undefined;
  commitConsolidation(input: {
    runId: string;
    workerId: string;
    expectedWorkingDigest: string;
    expectedLongTermDigest: string;
    externalWorkingMemory?: boolean;
    workingMemoryId: string;
    working: readonly DreamMemoryRecord[];
    longTerm: readonly DreamMemoryRecord[];
    archives: readonly {
      recordId: string;
      data: DreamMemoryRecord;
      reason: string;
      recallSnapshot: { recallCount: number; trackingStartedAt: string };
    }[];
    recallLineages: readonly { targetId: string; sourceIds: readonly string[] }[];
    reviews: readonly {
      recordId: string;
      sourceIds: readonly string[];
      importance: number;
      futureRelevance: number;
      emotionalSalience: number;
    }[];
    result: JsonObject;
    now?: Date;
  }):
    | { status: "committed" | "existing"; run: RuntimeDreamRun }
    | { status: "snapshot_conflict"; sources: Array<"working" | "long_term"> }
    | { status: "lease_lost" | "result_conflict"; run: RuntimeDreamRun };
  markPersona(input: {
    runId: string;
    workerId: string;
    status: Exclude<RuntimeDreamPersonaStatus, "pending">;
    persona?: JsonObject | null;
    now?: Date;
  }): RuntimeDreamRun | undefined;
  markFailed(input: {
    runId: string;
    workerId: string;
    errorCode: string;
    errorText: string;
    retryAt?: Date | null;
    now?: Date;
  }): RuntimeDreamRun | undefined;
  complete(input: { runId: string; workerId: string; now?: Date }): RuntimeDreamRun | undefined;
}
export interface RuntimeDreamModelPort {
  complete(request: unknown, options: {
    signal: AbortSignal;
    logContext: {
      conversationId: string;
      runId: string;
      stage: "memory";
      promptFamily: string;
    };
  }): Promise<string>;
}
export interface RuntimeDreamPersonaPort {
  read(id: "persona.preference" | "persona.relation"): Promise<{ content: string; revision: string }>;
  compareAndSwap(input: {
    id: "persona.preference" | "persona.relation";
    revision: string;
    content: string;
  }): Promise<void>;
}
export interface RuntimeDreamLogPort {
  write(event: {
    level: "info" | "error";
    action: string;
    runId?: string;
    localDate?: string;
    data?: JsonObject;
  }): Promise<void> | void;
}
export interface RuntimeDreamsOptions {
  store: RuntimeDreamStorePort;
  context: RuntimeDreamContextPort;
  workingMemory?: RuntimeDreamWorkingMemoryPort;
  prompt: RuntimeDreamPromptPort;
  model: RuntimeDreamModelPort;
  persona: RuntimeDreamPersonaPort;
  selection?: () => DreamMemorySelectionSettings;
  log?: RuntimeDreamLogPort;
  timeZone?: string;
  agentId: string;
  clock?: () => Date;
  workerId?: string;
  seedFactory?: () => string;
  tickIntervalMs?: number;
  leaseMs?: number;
  retryDelayMs?: number;
}
export interface RuntimeDreamHistoryItem {
  id: string;
  date: string;
  status: "pending" | "running" | "generated" | "completed" | "failed";
  dreamText?: string;
  scheduledFor: string;
  completedAt?: string;
  personalityChanged?: boolean;
  summary?: { merged: number; archived: number; promoted: number };
}
export interface RuntimeDreamHistory {
  items: RuntimeDreamHistoryItem[];
  timeZone: string;
  nextScheduledFor: string;
}
interface PersistedDreamInput {
  schemaVersion: 1;
  workingDigest: string;
  workingRevision?: string;
  longTermDigest: string;
  payload: JsonObject;
}
interface PreparedDreamRun {
  input: PersistedDreamInput;
  snapshot: RuntimeDreamContextSnapshot;
}
type DreamTickOptions = { occurrence?: DreamScheduleOccurrence; force?: boolean; onAccepted?: (run: RuntimeDreamRun) => Promise<void> | void };
export class RuntimeDreams {
  private readonly timeZone: string;
  private readonly clock: () => Date;
  private readonly workerId: string;
  private readonly seedFactory: () => string;
  private readonly tickIntervalMs: number;
  private readonly leaseMs: number;
  private readonly retryDelayMs: number;
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private inFlight?: Promise<RuntimeDreamRun | undefined>;
  private stopped = false;
  constructor(private readonly options: RuntimeDreamsOptions) {
    this.timeZone = validatedTimeZone(options.timeZone ?? dreamSystemTimeZone());
    this.clock = options.clock ?? (() => new Date());
    this.workerId = boundedId(options.workerId ?? `dream-${randomUUID()}`, "workerId");
    this.seedFactory = options.seedFactory ?? randomUUID;
    this.tickIntervalMs = positiveInterval(options.tickIntervalMs ?? DREAM_TICK_INTERVAL_MS, "tickIntervalMs");
    this.leaseMs = positiveInterval(options.leaseMs ?? DREAM_LEASE_MS, "leaseMs");
    this.retryDelayMs = positiveInterval(options.retryDelayMs ?? DREAM_RETRY_DELAY_MS, "retryDelayMs");
    boundedId(options.agentId, "agentId");
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    void this.tick().catch((error) => this.logFailure("dream.tick.failed", error));
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.logFailure("dream.tick.failed", error));
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
  tick(now = this.clock()): Promise<RuntimeDreamRun | undefined> {
    return this.launch(validDate(now, "now"));
  }
  force(now = this.clock(), onAccepted?: (run: RuntimeDreamRun) => Promise<void> | void): Promise<RuntimeDreamRun | undefined> {
    const checkedNow = validDate(now, "now");
    const localDate = dreamLocalDate(checkedNow, this.timeZone);
    const existing = this.options.store.getRunByLocalDate(localDate);
    if (existing?.status === "completed") {
      return Promise.reject(new DreamRunError("DREAM_ALREADY_COMPLETED", "今天的 Dream 已完成。", false));
    }
    if (existing && existing.status !== "failed" && !claimableRun(existing, checkedNow)) {
      return Promise.reject(new DreamRunError("DREAM_BUSY", "Dream 正在运行。", false));
    }
    const occurrence = existing
      ? { localDate, scheduledAt: existing.scheduledFor, timeZone: existing.timeZone, trigger: "catch_up" as const }
      : { localDate, scheduledAt: checkedNow.toISOString(), timeZone: this.timeZone, trigger: "catch_up" as const };
    return this.launch(checkedNow, { occurrence, force: true, onAccepted });
  }
  private launch(now: Date, options: DreamTickOptions = {}) {
    if (this.stopped) return Promise.resolve(undefined);
    if (this.inFlight) {
      return options.force
        ? Promise.reject(new DreamRunError("DREAM_BUSY", "Dream 正在运行。", false))
        : this.inFlight;
    }
    const controller = new AbortController();
    this.controller = controller;
    const task = this.runTick(now, controller.signal, options).finally(() => {
      if (this.controller === controller) this.controller = undefined;
      if (this.inFlight === task) this.inFlight = undefined;
    });
    this.inFlight = task;
    return task;
  }
  listHistory(limit = DREAM_HISTORY_LIMIT, now = this.clock()): RuntimeDreamHistory {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Dream history limit must be between 1 and 100.");
    }
    const checkedNow = validDate(now, "now");
    return {
      items: this.options.store.listRuns({ limit }).map(dreamHistoryItem),
      timeZone: this.timeZone,
      nextScheduledFor: nextDreamScheduledAt(checkedNow, this.timeZone)
    };
  }
  private async runTick(now: Date, signal: AbortSignal, options: DreamTickOptions) {
    this.options.store.purgeArchivedMemories?.({ now, limit: 100 });
    const occurrence = options.occurrence ?? latestDreamScheduleOccurrence({ now, timeZone: this.timeZone });
    const existing = this.options.store.getRunByLocalDate(occurrence.localDate);
    if (!options.force && !existing && this.isFreshInstallBeforeFirstRun(now, occurrence)) return undefined;
    if (existing && !options.force && !claimableRun(existing, now)) return existing;
    let prepared: PreparedDreamRun | undefined;
    let claimInput: Parameters<RuntimeDreamStorePort["claimDailyRun"]>[0];
    if (existing) {
      claimInput = {
        id: existing.id,
        localDate: existing.localDate,
        scheduledFor: existing.scheduledFor,
        timeZone: existing.timeZone,
        window: existing.window,
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        seed: existing.seed,
        inputDigest: existing.inputDigest,
        input: existing.input,
        ...(options.force ? { force: true } : {}),
        now
      };
    } else {
      const window = dreamWindow(occurrence);
      prepared = await this.prepareNewRun(now, occurrence, window);
      claimInput = {
        localDate: occurrence.localDate,
        scheduledFor: occurrence.scheduledAt,
        timeZone: occurrence.timeZone,
        window,
        workerId: this.workerId,
        leaseMs: this.leaseMs,
        seed: String(prepared.input.payload.seed),
        inputDigest: digestJson(prepared.input),
        input: toJsonObject(prepared.input, "dream input"),
        ...(options.force ? { force: true } : {}),
        now
      };
    }
    if (signal.aborted) return undefined;
    const claimed = this.options.store.claimDailyRun(claimInput);
    if (claimed.status === "busy" || claimed.status === "existing") {
      if (options.force) {
        const completed = claimed.run.status === "completed";
        throw new DreamRunError(
          completed ? "DREAM_ALREADY_COMPLETED" : "DREAM_BUSY",
          completed ? "今天的 Dream 已完成。" : "Dream 正在运行。",
          false
        );
      }
      return claimed.run;
    }
    return this.executeClaimed(claimed.run, prepared?.snapshot, signal, options.onAccepted);
  }
  private isFreshInstallBeforeFirstRun(now: Date, occurrence: DreamScheduleOccurrence) {
    if (this.options.store.listRuns({ limit: 1 }).length > 0) return false;
    return occurrence.localDate !== dreamLocalDate(now, this.timeZone);
  }
  private async prepareNewRun(
    now: Date,
    occurrence: DreamScheduleOccurrence,
    window: { start: string; end: string }
  ): Promise<PreparedDreamRun> {
    const snapshot = normalizedMemorySnapshot(await this.options.context.capture({
      now,
      localDate: occurrence.localDate,
      timeZone: occurrence.timeZone,
      window
    }));
    const seed = digestText(`${occurrence.localDate}:${this.seedFactory()}`);
    const selection = selectDreamMemories({
      seed,
      now,
      workingRecords: snapshot.workingRecords,
      longTermRecords: snapshot.longTermRecords,
      recallStats: snapshot.recallStats,
      ...this.options.selection?.()
    });
    const payload = projectDreamContextPayload(toJsonObject({
      schemaVersion: 1,
      seed,
      localDate: occurrence.localDate,
      scheduledFor: occurrence.scheduledAt,
      timeZone: occurrence.timeZone,
      memoryWindow: window,
      workingMemories: selection.selectedWorking.map(promptMemory),
      longTermMemories: selection.selectedLongTerm.map(promptMemory),
      recallStats: selection.selectedLongTerm.flatMap((item) => item.recallStats ? [item.recallStats] : []),
      personaEvidenceIds: selection.personaEvidenceIds,
      sourceMemoryIds: selection.sourceMemoryIds,
      userProfiles: snapshot.userProfiles,
      observedConversations: snapshot.recentConversations,
      activeTasks: snapshot.activeTasks,
      plannedDailySchedule: snapshot.plannedDailySchedule,
      persona: snapshot.persona
    }, "dream payload"));
    return {
      input: {
        schemaVersion: 1,
        workingDigest: validDigest(snapshot.workingDigest, "workingDigest"),
        ...(snapshot.workingRevision ? {
          workingRevision: validDigest(snapshot.workingRevision, "workingRevision")
        } : {}),
        longTermDigest: validDigest(snapshot.longTermDigest, "longTermDigest"),
        payload
      },
      snapshot
    };
  }
  private async executeClaimed(
    initial: RuntimeDreamRun,
    initialSnapshot: RuntimeDreamContextSnapshot | undefined,
    signal: AbortSignal,
    onAccepted?: (run: RuntimeDreamRun) => Promise<void> | void
  ): Promise<RuntimeDreamRun | undefined> {
    let run = initial;
    try {
      if (onAccepted) await onAccepted(run);
      const input = persistedInput(run.input);
      const expected = modelExpectations(input.payload);
      if (run.status === "running") {
        const request = await this.options.prompt.render(DREAM_PROMPT_ID, {
          [DREAM_PAYLOAD_VARIABLE]: input.payload,
          ...dreamPersonaPromptVariables(input.payload)
        });
        assertDreamProviderRequest(request);
        const text = await this.options.model.complete(request, {
          signal,
          logContext: {
            conversationId: `dream:${this.options.agentId}:${run.localDate}`,
            runId: run.id,
            stage: "memory",
            promptFamily: DREAM_PROMPT_ID
          }
        });
        if (signal.aborted) return undefined;
        const output = parseDreamModelOutput(text, expected);
        const generated = this.options.store.markGenerated({
          runId: run.id,
          workerId: this.workerId,
          output: toJsonObject(output, "dream output"),
          dreamText: output.dream.text,
          now: this.clock()
        });
        if (!generated) throw new DreamRunError("DREAM_LEASE_LOST", "Dream generation lease was lost.");
        run = generated;
        await this.log("info", "dream.generated", run, { dreamChars: [...output.dream.text].length });
      }

      if (run.status === "generated") {
        const output = normalizeStoredOutput(run.output, expected);
        const snapshot = initialSnapshot ?? normalizedMemorySnapshot(await this.options.context.capture({
          now: this.clock(),
          localDate: run.localDate,
          timeZone: run.timeZone,
          window: run.window
        }));
        if (signal.aborted) return undefined;
        const plan = buildDreamConsolidationPlan({
          runId: run.id,
          localDate: run.localDate,
          scheduledFor: run.scheduledFor,
          seed: run.seed,
          now: this.clock(),
          output,
          workingRecords: snapshot.workingRecords,
          longTermRecords: snapshot.longTermRecords,
          recallStats: recallStatsFromPayload(input.payload)
        });
        const committed = await commitDreamWithWorkingMemory({
          workingMemory: this.options.workingMemory,
          workingRevision: input.workingRevision,
          records: plan.working,
          runId: run.id,
          localDate: run.localDate,
          commit: (externalWorkingMemory) => this.options.store.commitConsolidation({
            runId: run.id,
            workerId: this.workerId,
            expectedWorkingDigest: input.workingDigest,
            expectedLongTermDigest: input.longTermDigest,
            externalWorkingMemory,
            workingMemoryId: plan.workingMemoryId,
            working: plan.working,
            longTerm: plan.longTerm,
            archives: plan.archives,
            recallLineages: composeDreamRecallLineages(plan.recallLineages, snapshot.longTermRecords),
            reviews: plan.reviews,
            result: toJsonObject(plan.result, "dream consolidation result"),
            now: this.clock()
          })
        });
        if (committed.status === "snapshot_conflict") {
          throw new DreamRunError(
            "DREAM_SNAPSHOT_CONFLICT",
            `Dream memory snapshot changed: ${committed.sources.join(", ")}.`,
            false
          );
        }
        if (committed.status === "lease_lost") {
          throw new DreamRunError("DREAM_LEASE_LOST", "Dream consolidation lease was lost.");
        }
        if (committed.status === "result_conflict") {
          throw new DreamRunError("DREAM_RESULT_CONFLICT", "Dream consolidation result conflicted.", false);
        }
        run = committed.run;
        await this.log("info", "dream.consolidated", run, plan.result);
      }

      if (run.status === "consolidated") {
        if (signal.aborted) return undefined;
        run = await this.applyPersona(run, normalizeStoredOutput(run.output, expected));
        const completed = this.options.store.complete({
          runId: run.id,
          workerId: this.workerId,
          now: this.clock()
        });
        if (!completed) throw new DreamRunError("DREAM_LEASE_LOST", "Dream completion lease was lost.");
        run = completed;
        await this.log("info", "dream.completed", run, dreamRunSummary(run.result));
      }
      return run;
    } catch (error) {
      if (signal.aborted || abortError(error)) return undefined;
      const failedAt = this.clock();
      const retryable = retryableDreamError(error);
      const retryAt = retryable && run.attemptCount < DREAM_MAX_ATTEMPTS
        ? new Date(failedAt.getTime() + this.retryDelayMs)
        : null;
      const failed = this.options.store.markFailed({
        runId: run.id,
        workerId: this.workerId,
        errorCode: errorCode(error),
        errorText: errorMessage(error),
        retryAt,
        now: failedAt
      });
      await this.logFailure("dream.run.failed", error, failed ?? run);
      return failed ?? run;
    }
  }
  private async applyPersona(run: RuntimeDreamRun, output: DreamModelOutputV1) {
    const adjustment = output.personaAdjustment;
    if (!adjustment) return this.requirePersonaMark(run, "none", null);
    const input = persistedInput(run.input);
    const evidence = buildPersonaEvidence(promptRecords(input.payload), recallStatsFromPayload(input.payload));
    const lastAppliedAt = this.options.store.listRuns({ limit: 100 })
      .find((item) => item.id !== run.id && item.personaStatus === "applied")?.personaUpdatedAt ?? null;
    const policy = evaluateDreamPersonaAdjustment(adjustment, evidence, {
      now: this.clock(),
      lastAppliedAt
    });
    const persona = toJsonObject({ adjustment, reasons: policy.reasons }, "dream persona result");
    if (!policy.eligible) return this.requirePersonaMark(run, "skipped", persona);
    try {
      const id = personaFileId(adjustment);
      const current = await this.options.persona.read(id);
      const next = appendPersonaStatement(current.content, adjustment.statement);
      if (next !== current.content) {
        await this.options.persona.compareAndSwap({ id, revision: current.revision, content: next });
      }
      return this.requirePersonaMark(run, "applied", persona);
    } catch (error) {
      return this.requirePersonaMark(run, "failed", toJsonObject({
        adjustment,
        error: errorMessage(error)
      }, "dream persona failure"));
    }
  }
  private requirePersonaMark(
    run: RuntimeDreamRun,
    status: Exclude<RuntimeDreamPersonaStatus, "pending" | "proposed">,
    persona: JsonObject | null
  ) {
    const updated = this.options.store.markPersona({
      runId: run.id,
      workerId: this.workerId,
      status,
      persona,
      now: this.clock()
    });
    if (!updated) throw new DreamRunError("DREAM_LEASE_LOST", "Dream persona lease was lost.");
    return updated;
  }
  private async log(
    level: "info" | "error",
    action: string,
    run?: RuntimeDreamRun,
    data?: JsonObject
  ) {
    if (!this.options.log) return;
    await this.options.log.write({
      level,
      action,
      runId: run?.id,
      localDate: run?.localDate,
      data
    });
  }
  private async logFailure(action: string, error: unknown, run?: RuntimeDreamRun) {
    await this.log("error", action, run, { error: errorMessage(error) }).catch(() => undefined);
  }
}
export function createRuntimeDreams(options: RuntimeDreamsOptions) {
  return new RuntimeDreams(options);
}
class DreamRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = true
  ) {
    super(message);
  }
}
function claimableRun(run: RuntimeDreamRun, now: Date) {
  if (run.status === "completed") return false;
  if (run.status === "failed") {
    if (run.attemptCount >= DREAM_MAX_ATTEMPTS || run.nextRetryAt == null) return false;
    return Date.parse(run.nextRetryAt) <= now.getTime();
  }
  return run.leaseUntil == null || Date.parse(run.leaseUntil) <= now.getTime();
}
function dreamWindow(occurrence: DreamScheduleOccurrence) {
  const scheduled = new Date(occurrence.scheduledAt);
  const previous = latestDreamScheduleOccurrence({
    now: new Date(scheduled.getTime() - 1),
    timeZone: occurrence.timeZone
  });
  return { start: previous.scheduledAt, end: occurrence.scheduledAt };
}
function promptMemory(item: ReturnType<typeof selectDreamMemories>["selectedWorking"][number]) {
  return {
    id: item.id,
    factuality: item.factuality,
    memory: item.record,
    recallStats: item.recallStats,
    selection: {
      lane: item.selectedBy,
      reasons: item.reasons,
      score: item.score,
      scoreComponents: item.scoreComponents
    }
  };
}
function normalizedMemorySnapshot(snapshot: RuntimeDreamContextSnapshot): RuntimeDreamContextSnapshot {
  return { ...snapshot, ...normalizeDreamMemorySnapshot(snapshot) };
}
function persistedInput(value: JsonObject): PersistedDreamInput {
  if (value.schemaVersion !== 1 || !isObject(value.payload)) {
    throw new DreamRunError("DREAM_INPUT_INVALID", "Stored Dream input is invalid.", false);
  }
  return {
    schemaVersion: 1,
    workingDigest: validDigest(value.workingDigest, "workingDigest"),
    ...(value.workingRevision == null ? {} : {
      workingRevision: validDigest(value.workingRevision, "workingRevision")
    }),
    longTermDigest: validDigest(value.longTermDigest, "longTermDigest"),
    payload: value.payload
  };
}
function modelExpectations(payload: JsonObject) {
  return {
    workingMemoryIds: promptMemoryIds(payload.workingMemories, "workingMemories"),
    longTermMemoryIds: promptMemoryIds(payload.longTermMemories, "longTermMemories"),
    personaEvidenceIds: stringArray(payload.personaEvidenceIds, "personaEvidenceIds")
  };
}
function promptMemoryIds(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new DreamRunError("DREAM_INPUT_INVALID", `${field} is invalid.`, false);
  return value.map((item, index) => {
    if (!isObject(item) || typeof item.id !== "string") {
      throw new DreamRunError("DREAM_INPUT_INVALID", `${field}[${index}] is invalid.`, false);
    }
    return item.id;
  });
}
function recallStatsFromPayload(payload: JsonObject): DreamRecallStatsSnapshot[] {
  if (!Array.isArray(payload.recallStats)) {
    throw new DreamRunError("DREAM_INPUT_INVALID", "recallStats is invalid.", false);
  }
  return payload.recallStats as DreamRecallStatsSnapshot[];
}
function promptRecords(payload: JsonObject) {
  return [payload.workingMemories, payload.longTermMemories].flatMap((value, groupIndex) => {
    if (!Array.isArray(value)) {
      throw new DreamRunError("DREAM_INPUT_INVALID", `memory group ${groupIndex} is invalid.`, false);
    }
    return value.map((item, index) => {
      if (!isObject(item) || !isObject(item.memory)) {
        throw new DreamRunError("DREAM_INPUT_INVALID", `memory group ${groupIndex}[${index}] is invalid.`, false);
      }
      return item.memory;
    });
  });
}
function normalizeStoredOutput(
  output: JsonObject | null,
  expected: ReturnType<typeof modelExpectations>
) {
  if (!output) throw new DreamRunError("DREAM_OUTPUT_MISSING", "Stored Dream output is missing.", false);
  return normalizeDreamModelOutput(output, expected);
}
function personaFileId(adjustment: DreamPersonaAdjustmentV1) {
  return adjustment.targetFile === "PREFERENCE.md" ? "persona.preference" as const : "persona.relation" as const;
}
function appendPersonaStatement(content: string, statement: string) {
  const normalized = statement.trim();
  if (content.split(/\r?\n/u).some((line) => line.trim() === `- ${normalized}`)) return content;
  const base = content.trimEnd();
  if (base.includes(PERSONA_SECTION)) return `${base}\n- ${normalized}\n`;
  return `${base}${base ? "\n\n" : ""}${PERSONA_SECTION}\n\n- ${normalized}\n`;
}
function digestJson(value: unknown) {
  return digestText(canonicalJson(value));
}
function digestText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("Dream input must contain JSON values only.");
}
function toJsonObject(value: unknown, field: string): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized == null) throw new Error(`${field} must be a JSON object.`);
  const parsed: unknown = JSON.parse(serialized);
  if (!isObject(parsed)) throw new Error(`${field} must be a JSON object.`);
  canonicalJson(parsed);
  return parsed;
}
function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DreamRunError("DREAM_INPUT_INVALID", `${field} is invalid.`, false);
  }
  return value as string[];
}
function validDigest(value: unknown, field: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${field} must be a SHA-256 digest.`);
  }
  return value;
}
function validDate(value: Date, field: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`${field} is invalid.`);
  return new Date(value.getTime());
}
function validatedTimeZone(value: string) {
  const normalized = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
  } catch {
    throw new Error(`Invalid Dream time zone: ${value}`);
  }
  return normalized;
}
function boundedId(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || [...normalized].length > 128) throw new Error(`${field} is invalid.`);
  return normalized;
}
function positiveInterval(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 100) throw new Error(`${field} must be at least 100ms.`);
  return value;
}
function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function errorCode(error: unknown) {
  if (error instanceof DreamRunError) return error.code;
  if (error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string") {
    return String((error as { code: string }).code).slice(0, 128);
  }
  return "DREAM_RUN_FAILED";
}
function retryableDreamError(error: unknown) {
  if (error instanceof DreamRunError) return error.retryable;
  if (!error || typeof error !== "object") return true;
  const declared = (error as { retryable?: unknown }).retryable;
  if (typeof declared === "boolean") return declared;
  const status = Number((error as { status?: unknown }).status);
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
function errorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message : String(error || "Dream run failed.");
}
function abortError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.message === "The operation was aborted");
}
