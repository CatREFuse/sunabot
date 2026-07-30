import type {
  DreamPersonaAdjustmentKind,
  DreamPersonaImpressionLevel,
  DreamPersonaImpressionRecord,
  DreamPersonaImpressionV1,
  DreamPersonaTargetFile
} from "./types.js";

const PERSONA_SECTION = "## 缓慢形成的倾向";
const MANAGED_START = "<!-- sunabot-dream-persona:active:start -->";
const MANAGED_END = "<!-- sunabot-dream-persona:active:end -->";
const LEVEL_RANK: Record<DreamPersonaImpressionLevel, number> = {
  observation: 1,
  stable: 2,
  core: 3
};
const PERSONA_KINDS = new Set<DreamPersonaAdjustmentKind>([
  "habit",
  "communication_preference",
  "relationship_tendency"
]);
const PERSONA_TARGETS = new Set<DreamPersonaTargetFile>(["PREFERENCE.md", "RELATION.md"]);

export const DREAM_PERSONA_TOPIC_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
export const DREAM_PERSONA_STATEMENT_MAX_CHARS = 80;

const UNSAFE_PERSONA_PATTERNS = [
  /(?:无条件|永远|永久|绝不|始终|总是|所有时候|任何情况下|不惜一切|第一位)/u,
  /(?:忽略|绕过|规避|越过|关闭|禁用|解除|服从|听从|顺从|盲从|优先于).{0,12}(?:规则|约束|限制|指令|命令|安全|边界|权限)?/u,
  /(?:规则|约束|指令|命令|系统提示|开发者消息|管理员|权限|密码|密钥|凭据|token|工具调用|安全边界|核心身份|价值观|道德倾向)/iu,
  /(?:要求|命令|强迫|操控|控制|欺骗|报复|伤害|自残|自杀|暴力|违法|仇恨)/u,
  /(?:心理诊断|精神疾病|人格障碍|抑郁症|焦虑症|精神病|永久消极|负面标签)/u,
  /\b(?:always|never|permanent(?:ly)?|unconditional(?:ly)?|ignore|bypass|disable|override|obey|submit|system prompt|developer message|credential|password|secret|token|permission|self-harm|suicide|diagnos(?:e|is))\b/iu
];

export interface DreamPersonaImpressionResolution {
  retained: DreamPersonaImpressionRecord[];
  active: DreamPersonaImpressionRecord[];
  covered: Array<{ id: string; coveredBy: string }>;
}

export function resolveDreamPersonaImpressions(
  records: readonly DreamPersonaImpressionRecord[]
): DreamPersonaImpressionResolution {
  const retained = [...records];
  const highestRankByScope = new Map<string, number>();
  for (const record of retained) {
    const key = impressionScopeKey(record.impression);
    const rank = LEVEL_RANK[record.impression.level];
    highestRankByScope.set(key, Math.max(highestRankByScope.get(key) ?? 0, rank));
  }
  const active = retained.filter((record) => (
    LEVEL_RANK[record.impression.level] === highestRankByScope.get(impressionScopeKey(record.impression))
  ));
  const firstWinnerByScope = new Map<string, DreamPersonaImpressionRecord>();
  for (const record of active) {
    const key = impressionScopeKey(record.impression);
    if (!firstWinnerByScope.has(key)) firstWinnerByScope.set(key, record);
  }
  const covered = retained.flatMap((record) => {
    const winner = firstWinnerByScope.get(impressionScopeKey(record.impression));
    return winner && LEVEL_RANK[record.impression.level] < LEVEL_RANK[winner.impression.level]
      ? [{ id: record.id, coveredBy: winner.id }]
      : [];
  });
  return { retained, active, covered };
}

export function renderActiveDreamPersonaImpressions(
  content: string,
  records: readonly DreamPersonaImpressionRecord[],
  targetFile: DreamPersonaTargetFile
) {
  const targetRecords = records.filter((record) => record.impression.targetFile === targetFile);
  const historicalStatements = new Set(targetRecords.map((record) => record.impression.statement.trim()));
  const withoutManagedBlock = stripManagedBlocks(content);
  const withoutLegacyGeneratedLines = stripLegacyGeneratedLines(
    withoutManagedBlock,
    historicalStatements
  );
  const base = withoutLegacyGeneratedLines.trimEnd();
  const activeStatements = [...new Set(
    resolveDreamPersonaImpressions(targetRecords).active
      .map((record) => record.impression.statement.trim())
      .filter(Boolean)
  )];
  if (!activeStatements.length) return base ? `${base}\n` : "";
  const block = [
    MANAGED_START,
    PERSONA_SECTION,
    "",
    ...activeStatements.map((statement) => `- ${statement}`),
    MANAGED_END
  ].join("\n");
  return `${base}${base ? "\n\n" : ""}${block}\n`;
}

export function normalizeDreamPersonaTopicKey(
  value: unknown,
  fallback?: DreamPersonaAdjustmentKind
) {
  if (value == null) return fallback ?? null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 1
    || normalized.length > 64
    || !DREAM_PERSONA_TOPIC_KEY_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function isSafeDreamPersonaStatement(value: string) {
  const statement = value.trim();
  const length = Array.from(statement).length;
  if (length < 4 || length > DREAM_PERSONA_STATEMENT_MAX_CHARS) return false;
  if (/[\r\n\u0000-\u001f\u007f`<>]/u.test(statement)) return false;
  if (/^(?:[-*#]|\d+[.)])\s*/u.test(statement)) return false;
  if (/(?:@\{|\{\{|https?:\/\/|file:)/iu.test(statement)) return false;
  if ((statement.match(/[。！？!?]/gu)?.length ?? 0) > 1) return false;
  if (UNSAFE_PERSONA_PATTERNS.some((pattern) => pattern.test(statement))) return false;
  return true;
}

export function parseStoredDreamPersonaImpression(
  value: unknown,
  fallbackLevel: DreamPersonaImpressionLevel = "stable"
): DreamPersonaImpressionV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || !PERSONA_KINDS.has(record.kind as DreamPersonaAdjustmentKind)) {
    return null;
  }
  if (
    typeof record.targetFile !== "string"
    || !PERSONA_TARGETS.has(record.targetFile as DreamPersonaTargetFile)
  ) {
    return null;
  }
  const kind = record.kind as DreamPersonaAdjustmentKind;
  const targetFile = record.targetFile as DreamPersonaTargetFile;
  if (
    (kind === "relationship_tendency" && targetFile !== "RELATION.md")
    || (kind !== "relationship_tendency" && targetFile !== "PREFERENCE.md")
  ) {
    return null;
  }
  const topicKey = normalizeDreamPersonaTopicKey(record.topicKey ?? record.topic_key, kind);
  const level = "level" in record ? personaImpressionLevel(record.level) : fallbackLevel;
  const statement = typeof record.statement === "string" ? record.statement.trim() : "";
  const evidenceMemoryIds = Array.isArray(record.evidenceMemoryIds)
    && record.evidenceMemoryIds.every((id): id is string => typeof id === "string")
    ? record.evidenceMemoryIds
    : [];
  if (
    !topicKey
    || !level
    || !isSafeDreamPersonaStatement(statement)
    || evidenceMemoryIds.length < 2
    || new Set(evidenceMemoryIds).size !== evidenceMemoryIds.length
  ) {
    return null;
  }
  return { kind, targetFile, topicKey, level, statement, evidenceMemoryIds };
}

function personaImpressionLevel(value: unknown): DreamPersonaImpressionLevel | null {
  return value === "observation" || value === "stable" || value === "core" ? value : null;
}

function impressionScopeKey(impression: DreamPersonaImpressionV1) {
  return `${impression.targetFile}\u0000${impression.topicKey}`;
}

function stripManagedBlocks(content: string) {
  const lines = content.split(/\r?\n/u);
  while (true) {
    const start = lines.findIndex((line) => line.trim() === MANAGED_START);
    if (start < 0) break;
    const endOffset = lines.slice(start + 1).findIndex((line) => line.trim() === MANAGED_END);
    if (endOffset < 0) break;
    lines.splice(start, endOffset + 2);
  }
  return lines.join("\n");
}

function stripLegacyGeneratedLines(content: string, statements: ReadonlySet<string>) {
  if (!statements.size) return content;
  const lines = content.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() !== PERSONA_SECTION) continue;
    let end = index + 1;
    while (end < lines.length && !/^##\s+\S/u.test(lines[end]?.trim() ?? "")) end += 1;
    const body = lines.slice(index + 1, end).filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("- ") || !statements.has(trimmed.slice(2).trim());
    });
    if (body.every((line) => !line.trim())) {
      lines.splice(index, end - index);
      index -= 1;
      continue;
    }
    lines.splice(index + 1, end - index - 1, ...body);
    index += body.length;
  }
  return lines.join("\n");
}
