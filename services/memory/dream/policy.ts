import type {
  DreamArchivePolicyResult,
  DreamArchiveRejectionReason,
  DreamLongTermArchiveCandidate,
  DreamPersonaAdjustmentV1,
  DreamPersonaEvidence,
  DreamPersonaPolicyResult,
  DreamPersonaRejectionReason
} from "./types.js";
import { normalizeText } from "../domain/normalizers.js";

export const DREAM_ARCHIVE_MIN_TRACKING_DAYS = 90;
export const DREAM_ARCHIVE_LOW_SCORE_MAX = 0.25;
export const DREAM_PERSONA_MIN_EVIDENCE_EVENTS = 3;
export const DREAM_PERSONA_MIN_CONTEXTS = 2;
export const DREAM_PERSONA_MIN_SPAN_DAYS = 14;
export const DREAM_PERSONA_COOLDOWN_DAYS = 30;
export const DREAM_PERSONA_STATEMENT_MAX_CHARS = 80;
export const DREAM_PERSONA_MIN_IMPACT_SCORE = 0.65;

const DAY_MS = 24 * 60 * 60 * 1_000;
const HIGH_IMPACT_EVENT_TYPES = new Set([
  "boundary",
  "commitment",
  "conflict",
  "goal",
  "identity",
  "relationship",
  "relationship_change",
  "safety"
]);

export function dreamPersonaImpactScore(
  record: Record<string, unknown>,
  scores?: {
    importance?: number | null;
    futureRelevance?: number | null;
    emotionalSalience?: number | null;
  } | null
) {
  const values: number[] = [];
  for (const value of [
    scores?.importance,
    scores?.futureRelevance,
    scores?.emotionalSalience,
    record.importance,
    record.futureRelevance,
    record.emotionalSalience,
    record.relationshipImpact
  ]) {
    if (validScore(value)) values.push(value);
  }
  if (record.relationshipImpact === true || HIGH_IMPACT_EVENT_TYPES.has(normalizeText(record.eventType).toLowerCase())) {
    values.push(1);
  }
  return values.length ? Math.max(...values) : 0;
}

export function evaluateDreamArchiveCandidate(
  candidate: DreamLongTermArchiveCandidate,
  now = new Date()
): DreamArchivePolicyResult {
  const reasons: DreamArchiveRejectionReason[] = [];
  const nowTime = now.getTime();
  const trackingStartedAt = Date.parse(candidate.trackingStartedAt);
  if (
    !Number.isFinite(nowTime)
    || !Number.isSafeInteger(candidate.recallCount)
    || candidate.recallCount < 0
    || !Number.isFinite(trackingStartedAt)
    || trackingStartedAt > nowTime
    || !validScore(candidate.importance)
    || !validScore(candidate.futureRelevance)
    || !validScore(candidate.emotionalSalience)
    || !validBooleanFields(candidate)
  ) {
    reasons.push("invalid_candidate");
    return { eligible: false, reasons };
  }
  if (candidate.recallCount !== 0) reasons.push("recalled");
  if (nowTime - trackingStartedAt < DREAM_ARCHIVE_MIN_TRACKING_DAYS * DAY_MS) {
    reasons.push("tracking_too_recent");
  }
  if (candidate.importance > DREAM_ARCHIVE_LOW_SCORE_MAX) reasons.push("importance_too_high");
  if (candidate.futureRelevance > DREAM_ARCHIVE_LOW_SCORE_MAX) reasons.push("future_relevance_too_high");
  if (candidate.emotionalSalience > DREAM_ARCHIVE_LOW_SCORE_MAX) reasons.push("emotional_salience_too_high");
  if (candidate.hasActiveReferences) reasons.push("active_reference");
  if (candidate.protectedFromDream) reasons.push("protected");
  if (candidate.manuallyPinned) reasons.push("manually_pinned");
  if (candidate.unique) reasons.push("unique");
  return { eligible: reasons.length === 0, reasons };
}

export function evaluateDreamPersonaAdjustment(
  adjustment: DreamPersonaAdjustmentV1,
  evidence: readonly DreamPersonaEvidence[],
  options: { now?: Date; lastAppliedAt?: string | null } = {}
): DreamPersonaPolicyResult {
  const reasons: DreamPersonaRejectionReason[] = [];
  const now = options.now ?? new Date();
  const nowTime = now.getTime();
  if (!validAdjustment(adjustment)) reasons.push("unsupported_adjustment");
  else if (!safePersonaStatement(adjustment.statement)) reasons.push("unsafe_adjustment");

  const evidenceIds = Array.isArray(adjustment.evidenceMemoryIds)
    ? adjustment.evidenceMemoryIds
    : [];
  if (evidenceIds.length < DREAM_PERSONA_MIN_EVIDENCE_EVENTS || new Set(evidenceIds).size !== evidenceIds.length) {
    reasons.push("insufficient_evidence");
  }
  const evidenceById = new Map<string, DreamPersonaEvidence>();
  for (const item of evidence) {
    if (!evidenceById.has(item.id)) evidenceById.set(item.id, item);
  }
  const selected = evidenceIds.map((id) => evidenceById.get(id));
  if (selected.some((item) => !item)) reasons.push("missing_evidence");
  const available = selected.filter((item): item is DreamPersonaEvidence => Boolean(item));
  if (available.some((item) => item.factuality !== "factual")) reasons.push("imagined_evidence");
  if (available.some((item) => !validScore(item.impactScore) || item.impactScore < DREAM_PERSONA_MIN_IMPACT_SCORE)) {
    reasons.push("insufficient_impact");
  }

  const eventIds = new Set(available.map((item) => item.eventId.trim()).filter(Boolean));
  if (eventIds.size < DREAM_PERSONA_MIN_EVIDENCE_EVENTS) reasons.push("insufficient_independent_events");
  const contexts = new Set(available.map((item) => item.context.trim()).filter(Boolean));
  if (contexts.size < DREAM_PERSONA_MIN_CONTEXTS) reasons.push("insufficient_contexts");

  const evidenceTimes = available.map((item) => Date.parse(item.occurredAt));
  if (
    !Number.isFinite(nowTime)
    || evidenceTimes.some((timestamp) => !Number.isFinite(timestamp) || timestamp > nowTime)
  ) {
    reasons.push("invalid_evidence_time");
  } else if (
    evidenceTimes.length < DREAM_PERSONA_MIN_EVIDENCE_EVENTS
    || Math.max(...evidenceTimes) - Math.min(...evidenceTimes) < DREAM_PERSONA_MIN_SPAN_DAYS * DAY_MS
  ) {
    reasons.push("insufficient_time_span");
  }

  if (options.lastAppliedAt) {
    const lastAppliedAt = Date.parse(options.lastAppliedAt);
    if (!Number.isFinite(nowTime) || !Number.isFinite(lastAppliedAt) || lastAppliedAt > nowTime) {
      reasons.push("invalid_cooldown");
    } else if (nowTime - lastAppliedAt < DREAM_PERSONA_COOLDOWN_DAYS * DAY_MS) {
      reasons.push("cooldown_active");
    }
  }
  const uniqueReasons = [...new Set(reasons)];
  return { eligible: uniqueReasons.length === 0, reasons: uniqueReasons };
}

function validAdjustment(adjustment: DreamPersonaAdjustmentV1) {
  if (!adjustment || typeof adjustment !== "object") return false;
  const statement = typeof adjustment.statement === "string" ? adjustment.statement.trim() : "";
  if (!statement) return false;
  if (adjustment.kind === "relationship_tendency") return adjustment.targetFile === "RELATION.md";
  return (
    (adjustment.kind === "habit" || adjustment.kind === "communication_preference")
    && adjustment.targetFile === "PREFERENCE.md"
  );
}

const GENTLE_CHANGE_CUES = [
  "有时", "偶尔", "逐渐", "倾向", "偏好", "尝试", "愿意", "留出", "会先", "先确认", "会更",
  "稍", "适度", "保持", "习惯", "不急于", "更注意", "更重视", "更常", "更少"
];

const UNSAFE_PERSONA_PATTERNS = [
  /(?:无条件|永远|永久|绝不|始终|总是|所有时候|任何情况下|不惜一切|第一位)/u,
  /(?:忽略|绕过|规避|越过|关闭|禁用|解除|服从|听从|顺从|盲从|优先于).{0,12}(?:规则|约束|限制|指令|命令|安全|边界|权限)?/u,
  /(?:规则|约束|指令|命令|系统提示|开发者消息|管理员|权限|密码|密钥|凭据|token|工具调用|安全边界|核心身份|价值观|道德倾向)/iu,
  /(?:要求|命令|强迫|操控|控制|欺骗|报复|伤害|自残|自杀|暴力|违法|仇恨)/u,
  /(?:心理诊断|精神疾病|人格障碍|抑郁症|焦虑症|精神病|永久消极|负面标签)/u,
  /\b(?:always|never|permanent(?:ly)?|unconditional(?:ly)?|ignore|bypass|disable|override|obey|submit|system prompt|developer message|credential|password|secret|token|permission|self-harm|suicide|diagnos(?:e|is))\b/iu
];

function safePersonaStatement(value: string) {
  const statement = value.trim();
  const length = Array.from(statement).length;
  if (length < 4 || length > DREAM_PERSONA_STATEMENT_MAX_CHARS) return false;
  if (/[\r\n\u0000-\u001f\u007f`<>]/u.test(statement)) return false;
  if (/^(?:[-*#]|\d+[.)])\s*/u.test(statement)) return false;
  if (/(?:@\{|\{\{|https?:\/\/|file:)/iu.test(statement)) return false;
  if ((statement.match(/[。！？!?]/gu)?.length ?? 0) > 1) return false;
  if (UNSAFE_PERSONA_PATTERNS.some((pattern) => pattern.test(statement))) return false;
  return GENTLE_CHANGE_CUES.some((cue) => statement.includes(cue));
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validBooleanFields(candidate: DreamLongTermArchiveCandidate) {
  return [
    candidate.hasActiveReferences,
    candidate.protectedFromDream,
    candidate.manuallyPinned,
    candidate.unique
  ].every((value) => typeof value === "boolean");
}
