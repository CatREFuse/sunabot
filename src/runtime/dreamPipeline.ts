import { randomUUID } from "node:crypto";
import { dreamPersonaPromptVariables, projectDreamContext, restoreDreamFieldKnowledge, type DreamFieldKnowledgeBinding } from "./dreamContextProjection.js";
import {
  dreamErrorCode,
  dreamFailureText,
  dreamHistoryItem,
  dreamRunSummary,
  nextDreamScheduledAt
} from "./dreamHistory.js";
import { assertDreamProviderRequest } from "./dreamProviderRequest.js";
import {
  commitDreamWithWorkingMemory,
  type RuntimeDreamFieldKnowledgePort,
  type RuntimeDreamWorkingMemoryPort
} from "./dreamWorkingMemoryCommit.js";
import {
  activeDreamPersonaImpressionCatalog,
  applyDreamPersonaImpressionProjection
} from "./dreamPersonaImpressions.js";
import {
  boundedDreamPipelineId as boundedId,
  digestDreamPipelineJson as digestJson,
  digestDreamPipelineText as digestText,
  dreamPipelineFieldKnowledgeBindings,
  isDreamPipelineAbortError as abortError,
  isRetryableDreamPipelineError as retryableDreamError,
  isDreamPipelineObject as isObject,
  positiveDreamInterval as positiveInterval,
  toDreamPipelineJsonObject as toJsonObject,
  validDreamPipelineDate as validDate,
  validDreamPipelineDigest as validDigest,
  validatedDreamTimeZone as validatedTimeZone,
  type DreamPipelineJsonObject as JsonObject
} from "./dreamPipelineSupport.js";
import type { RuntimeDreamContextPort, RuntimeDreamContextSnapshot, RuntimeDreamPromptPort } from "./dreamPorts.js";
export type { RuntimeDreamWorkingMemoryPort, RuntimeDreamFieldKnowledgePort } from "./dreamWorkingMemoryCommit.js";
export type { RuntimeDreamContextPort, RuntimeDreamContextSnapshot, RuntimeDreamPromptPort } from "./dreamPorts.js";
import {
  DREAM_PAYLOAD_VARIABLE,
  DREAM_PROMPT_ID,
  buildPersonaEvidence,
  buildDreamConsolidationPlan,
  composeDreamRecallLineages,
  dreamLocalDate,
  dreamSystemTimeZone,
  DreamModelOutputContractError,
  evaluateDreamPersonaAdjustment,
  latestDreamScheduleOccurrence,
  normalizeDreamMemorySnapshot,
  parseStrictDreamModelOutput,
  selectDreamMemories,
  type DreamMemorySelectionSettings, type DreamMemoryRecord,
  type DreamModelOutputV1,
  type DreamRecallStatsSnapshot,
  type DreamScheduleOccurrence
} from "../../services/memory/dream/public.js";
const DREAM_TICK_INTERVAL_MS = 60_000;
const DREAM_LEASE_MS = 45 * 60_000;
const DREAM_RETRY_DELAY_MS = 15 * 60_000;
const DREAM_MAX_ATTEMPTS = 3;
const DREAM_HISTORY_LIMIT = 30;
const DREAM_PERSONA_PROJECTION_FAILED = "DREAM_PERSONA_PROJECTION_FAILED";
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
      recallSnapshot: {
        recallCount: number;
        distinctRecallDays: number;
        lastRecalledAt: string | null;
        trackingStartedAt: string;
      };
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
    resetGeneratedOutput?: boolean;
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
  fieldKnowledge?: RuntimeDreamFieldKnowledgePort;
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
  attemptCount: number; maxAttempts: 3;
  dreamText?: string;
  scheduledFor: string;
  completedAt?: string;
  errorCode?: string; errorText?: string;
  nextRetryAt?: string; failedAt?: string;
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
  fieldKnowledgeRevision?: string;
  fieldKnowledgeBindings?: DreamFieldKnowledgeBinding[];
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
    const selectionSettings = this.options.selection?.();
    const selection = selectDreamMemories({
      seed,
      now,
      workingRecords: snapshot.workingRecords,
      longTermRecords: snapshot.longTermRecords,
      recallStats: snapshot.recallStats,
      ...selectionSettings
    });
    const projection = projectDreamContext(toJsonObject({
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
      fieldKnowledgeEvidenceIds: selection.fieldKnowledgeEvidenceIds,
      recentWindowHours: selectionSettings?.recentWindowHours ?? 24,
      sourceMemoryIds: selection.sourceMemoryIds,
      userProfiles: snapshot.userProfiles,
      observedConversations: snapshot.recentConversations,
      activeTasks: snapshot.activeTasks,
      plannedDailySchedule: snapshot.plannedDailySchedule,
      persona: snapshot.persona,
      personaImpressions: activeDreamPersonaImpressionCatalog(this.options.store)
    }, "dream payload"));
    const payload = projection.payload;
    return {
      input: {
        schemaVersion: 1,
        workingDigest: validDigest(snapshot.workingDigest, "workingDigest"),
        ...(snapshot.workingRevision ? {
          workingRevision: validDigest(snapshot.workingRevision, "workingRevision")
        } : {}),
        ...(snapshot.fieldKnowledgeRevision && payload.fieldKnowledgeWritable === true ? {
          fieldKnowledgeRevision: validDigest(
            snapshot.fieldKnowledgeRevision,
            "fieldKnowledgeRevision"
          ),
          ...(projection.fieldKnowledgeBindings.length
            ? { fieldKnowledgeBindings: projection.fieldKnowledgeBindings } : {})
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
        const output = parseStrictDreamModelOutput(text, expected);
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
          recallStats: recallStatsFromPayload(input.payload),
          recentWindowHours: recentWindowHoursFromPayload(input.payload)
        });
        const externalCommit = await commitDreamWithWorkingMemory({
          workingMemory: this.options.workingMemory,
          workingRevision: input.workingRevision,
          records: plan.working,
          fieldKnowledge: this.options.fieldKnowledge,
          fieldKnowledgeRevision: input.fieldKnowledgeRevision,
          fieldKnowledgeContent: output.fieldKnowledge?.content == null ? undefined
            : restoreDreamFieldKnowledge(output.fieldKnowledge.content, input.fieldKnowledgeBindings ?? []),
          runId: run.id,
          localDate: run.localDate,
          commit: (externalWorkingMemory, fieldKnowledgeUpdated) => this.options.store.commitConsolidation({
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
            result: toJsonObject({
              ...plan.result,
              fieldKnowledgeUpdated
            }, "dream consolidation result"),
            now: this.clock()
          })
        });
        const committed = externalCommit.committed;
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
        await this.log("info", "dream.consolidated", run, {
          ...plan.result,
          fieldKnowledgeUpdated: externalCommit.fieldKnowledgeUpdated
        });
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
      const failureCode = dreamErrorCode(error);
      const retryable = retryableDreamError(error);
      const retryAt = retryable && run.attemptCount < DREAM_MAX_ATTEMPTS
        ? new Date(failedAt.getTime() + this.retryDelayMs)
        : null;
      const failed = this.options.store.markFailed({
        runId: run.id,
        workerId: this.workerId,
        errorCode: failureCode,
        errorText: dreamFailureText(failureCode),
        ...(failureCode === "DREAM_OUTPUT_CONTRACT_INVALID" && run.status === "generated"
          ? { resetGeneratedOutput: true } : {}),
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
    const now = this.clock();
    const policy = evaluateDreamPersonaAdjustment(adjustment, evidence, {
      now
    });
    const persona = toJsonObject({ adjustment, reasons: policy.reasons }, "dream persona result");
    if (!policy.eligible) return this.requirePersonaMark(run, "skipped", persona);
    try {
      const projection = await applyDreamPersonaImpressionProjection({
        store: this.options.store,
        persona: this.options.persona,
        adjustment,
        level: policy.level!,
        runId: run.id,
        appliedAt: now.toISOString()
      });
      return this.requirePersonaMark(run, "applied", toJsonObject({
        adjustment,
        reasons: policy.reasons,
        ...projection
      }, "dream persona result"));
    } catch (error) {
      return this.requirePersonaMark(run, "failed", toJsonObject({
        adjustment,
        reasons: policy.reasons,
        errorCode: DREAM_PERSONA_PROJECTION_FAILED
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
    await this.log("error", action, run, { errorCode: dreamErrorCode(error) }).catch(() => undefined);
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
    ...(value.fieldKnowledgeRevision == null || value.payload.fieldKnowledgeWritable !== true ? {} : {
      fieldKnowledgeRevision: validDigest(value.fieldKnowledgeRevision, "fieldKnowledgeRevision"),
      ...(value.fieldKnowledgeBindings == null ? {}
        : { fieldKnowledgeBindings: dreamPipelineFieldKnowledgeBindings(value.fieldKnowledgeBindings) })
    }),
    longTermDigest: validDigest(value.longTermDigest, "longTermDigest"),
    payload: value.payload
  };
}
function modelExpectations(payload: JsonObject) {
  return {
    workingMemoryIds: promptMemoryIds(payload.workingMemories, "workingMemories"),
    longTermMemoryIds: promptMemoryIds(payload.longTermMemories, "longTermMemories"),
    personaEvidenceIds: stringArray(payload.personaEvidenceIds, "personaEvidenceIds"),
    fieldKnowledgeEvidenceIds: stringArray(
      payload.fieldKnowledgeEvidenceIds ?? [],
      "fieldKnowledgeEvidenceIds"
    ),
    fieldKnowledgeWritable: payload.fieldKnowledgeWritable === true
  };
}
function recentWindowHoursFromPayload(payload: JsonObject) {
  const value = payload.recentWindowHours;
  if (value == null) return 48;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 720) {
    throw new DreamRunError("DREAM_INPUT_INVALID", "recentWindowHours is invalid.", false);
  }
  return Number(value);
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
  if (typeof output.rawOutput !== "string") {
    throw new DreamModelOutputContractError("stored rawOutput must be present");
  }
  return parseStrictDreamModelOutput(output.rawOutput, expected);
}
function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DreamRunError("DREAM_INPUT_INVALID", `${field} is invalid.`, false);
  }
  return value as string[];
}
