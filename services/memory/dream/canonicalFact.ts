import {
  normalizeAddressNames,
  normalizeStringArray,
  normalizeText,
  normalizeUserIds
} from "../domain/normalizers.js";

export type DreamCanonicalFactRejectionReason =
  | "invalid_fact"
  | "recall_prompt"
  | "missing_role_first_person"
  | "unsupported_identity"
  | "unsupported_high_risk_claim"
  | "insufficient_source_coverage";

export interface DreamCanonicalFactResult {
  eligible: boolean;
  reasons: DreamCanonicalFactRejectionReason[];
  sourceBigramCoverage: number;
}

export type DreamCanonicalFactSource = Record<string, unknown>;

export const DREAM_CANONICAL_MIN_SOURCE_BIGRAM_COVERAGE = 0.7;

const RECALL_PROMPT_PATTERNS = [
  /(?:^|[，。！？；：、\s])我(?:还|仍|一直|清楚地|依然|总)?(?:记得|记着|想起|回想起|回忆起|记起)/u,
  /(?:在|从|根据)?我(?:的)?(?:记忆|回忆)(?:中|里|来看|得知)/u,
  /(?:^|[，。！？；：、\s])(?:回想|回忆|想起|记起|记忆中)(?:起来)?[，,:：]?我/u,
  /\b(?:i\s+(?:still\s+)?remember|i\s+recall|as\s+i\s+remember|from\s+my\s+memory)\b/iu
];

const ROLE_FIRST_PERSON_SUBJECT_PATTERN = /^(?:(?:后来|随后|最后|当时|现在|目前|今天|昨日|昨天|近期|这次|同时|因此|于是|接着|最终|起初|此前|之后)[，,\s]*)*(?:我(?:自己|本人)?|\b(?:i|we|my|our)\b)/iu;
const QUOTED_FIRST_PERSON_PATTERN = /["'“‘「『][^"'“”‘’「」『』\r\n]{0,120}?(?:我(?:自己|本人)?|\b(?:i|we|my|our)\b)/iu;
const REPORTED_FIRST_PERSON_PATTERN = /(?:说(?:道)?|讲(?:道)?|表示|提到|自述|回答|声称|写道|解释(?:道)?|回应(?:道)?|回复(?:道)?|转述|告诉(?:了)?我)\s*[:：]\s*(?:我(?:自己|本人)?|\b(?:i|we|my|our)\b)/iu;

const SAFE_ADDITION_TOKENS = new Set([
  "我", "们", "的", "了", "和", "与", "在", "对", "将", "会", "仍", "已", "又", "后", "前",
  "并", "而", "但", "因", "所", "以", "把", "被", "让", "从", "到", "为", "及", "也", "更",
  "曾", "正", "这", "那", "次", "件", "随后", "后来", "因此", "同时", "其中", "最后", "继续",
  "i", "we", "my", "our", "the", "a", "an", "and", "but", "after", "before", "then", "still"
]);

const HIGH_RISK_TERMS = [
  "不惜一切", "安全边界", "自杀", "自残", "伤害", "威胁", "报复", "报警", "举报", "犯罪", "违法",
  "转账", "付款", "支付", "汇款", "借款", "还款", "欠款", "赔偿", "投资", "签署", "辞职", "解雇", "开除",
  "住院", "诊断", "用药", "怀孕", "结婚", "离婚", "死亡", "密码", "密钥", "凭据", "承诺", "答应",
  "同意", "拒绝", "决定", "必须", "保证", "约定", "删除", "公开", "泄露", "定位", "跟踪",
  "suicide", "self-harm", "hurt", "kill", "threaten", "police", "report", "crime", "illegal",
  "transfer", "payment", "loan", "debt", "compensation", "invest", "sign", "resign", "fire",
  "hospital", "diagnosis", "medication", "pregnant", "marry", "divorce", "death", "password", "secret",
  "credential", "promise", "agree", "refuse", "decide", "must", "guarantee", "delete", "publish", "leak"
] as const;

const NEGATION_PATTERN = /(?:从未|尚未|并未|没有|不能|不会|不曾|不是|并非|拒绝|取消|撤回|停止|未|没|不|无)/u;
const ADVERSE_OUTCOME_PATTERN = /^(?:失败|未成|未完成|取消|撤回|停止|作废|无效|failed|cancelled|canceled|rejected)/iu;
const PLANNED_PATTERN = /(?:计划|打算|准备|考虑|可能|想要|将要|会|将|plan(?:ned)?|intend|consider|might|may|will)/iu;
const COMPLETED_PATTERN = /(?:已经|已|完成|成功|刚刚|曾经|确实|already|completed|successfully|did)/iu;
const QQ_PAIR_PATTERN = /([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_·・-]{0,31})\s*[（(]\s*(?:QQ(?:号)?\s*[:：#]?\s*)?(\d{5,12})(?!\d)\s*[）)]/giu;
const TOKEN_PATTERN = /[\p{Script=Han}]|[\p{L}\p{N}_-]+/gu;

export function evaluateDreamCanonicalFact(
  canonicalFact: unknown,
  sources: readonly DreamCanonicalFactSource[]
): DreamCanonicalFactResult {
  const fact = normalizeText(canonicalFact).normalize("NFKC");
  const sourceFacts = sources.map((source) => normalizeText(source.fact).normalize("NFKC")).filter(Boolean);
  const reasons: DreamCanonicalFactRejectionReason[] = [];
  if (!fact || !sourceFacts.length) reasons.push("invalid_fact");
  if (RECALL_PROMPT_PATTERNS.some((pattern) => pattern.test(fact))) reasons.push("recall_prompt");
  if (!hasRoleFirstPersonPerspective(fact)) reasons.push("missing_role_first_person");

  const identity = sourceIdentityEvidence(sources, sourceFacts);
  if (!identitiesSupported(fact, identity)) reasons.push("unsupported_identity");
  if (!highRiskClaimsSupported(fact, sourceFacts)) reasons.push("unsupported_high_risk_claim");

  const coverage = sourceCoverage(fact, sourceFacts, identity.trustedTokens);
  if (!coverage.supported) reasons.push("insufficient_source_coverage");
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    sourceBigramCoverage: coverage.ratio
  };
}

function sourceIdentityEvidence(
  sources: readonly DreamCanonicalFactSource[],
  sourceFacts: readonly string[]
) {
  const ids = new Set(sourceFacts.flatMap(extractDigitRuns));
  const names = new Set<string>();
  const allowedPairs = new Set<string>();
  const requiredPairs = new Set<string>();
  const requiredIdentityIds = new Set<string>();
  let ambiguousMetadata = false;
  for (const source of sources) {
    const sourceIds = new Set([
      ...normalizeUserIds(source.userIds),
      ...normalizeUserIds(source.userId),
      ...normalizeStringArray(source.relatedUserIds)
    ]);
    const sourceNames = new Set([
      ...normalizeAddressNames(source.addressNames),
      ...normalizeAddressNames(source.addressName ?? source.address_name ?? source.salutation)
    ].map((name) => name.normalize("NFKC")));
    const sourceFact = normalizeText(source.fact).normalize("NFKC");
    const explicitPairs = pairedIdentities(sourceFact, sourceNames);
    for (const pair of explicitPairs) {
      sourceIds.add(pair.id);
      sourceNames.add(pair.name);
      allowedPairs.add(identityPairKey(pair));
      requiredPairs.add(identityPairKey(pair));
    }
    for (const id of sourceIds) ids.add(id);
    for (const name of sourceNames) names.add(name);

    if (sourceIds.size === 1 && sourceNames.size) {
      const id = [...sourceIds][0]!;
      requiredIdentityIds.add(id);
      for (const name of sourceNames) allowedPairs.add(identityPairKey({ name, id }));
    } else if (sourceIds.size > 1 && sourceNames.size) {
      const explicitlyPairedIds = new Set(explicitPairs.map((pair) => pair.id));
      if ([...sourceIds].some((id) => !explicitlyPairedIds.has(id))) ambiguousMetadata = true;
    }
  }
  const trustedTokens = new Set<string>();
  for (const value of [...ids, ...names]) {
    for (const token of factTokens(value)) trustedTokens.add(token);
  }
  if (allowedPairs.size) {
    for (const token of factTokens("QQ QQ号")) trustedTokens.add(token);
  }
  return {
    ids,
    names,
    allowedPairs,
    requiredPairs,
    requiredIdentityIds,
    ambiguousMetadata,
    trustedTokens
  };
}

function identitiesSupported(
  fact: string,
  source: {
    ids: ReadonlySet<string>;
    names: ReadonlySet<string>;
    allowedPairs: ReadonlySet<string>;
    requiredPairs: ReadonlySet<string>;
    requiredIdentityIds: ReadonlySet<string>;
    ambiguousMetadata: boolean;
  }
) {
  if (source.ambiguousMetadata) return false;
  if (extractDigitRuns(fact).some((id) => !source.ids.has(id))) return false;
  const factPairs = pairedIdentities(fact, source.names);
  if (!factPairs.every((pair) => source.allowedPairs.has(identityPairKey(pair)))) return false;
  const factPairKeys = new Set(factPairs.map(identityPairKey));
  if ([...source.requiredPairs].some((pair) => !factPairKeys.has(pair))) return false;
  return [...source.requiredIdentityIds].every((id) => factPairs.some((pair) => pair.id === id));
}

function pairedIdentities(value: string, trustedNames: ReadonlySet<string> = new Set()) {
  return [...value.matchAll(QQ_PAIR_PATTERN)].map((match) => ({
    name: trustedIdentityName(match[1]!.normalize("NFKC"), trustedNames),
    id: match[2]!
  }));
}

function trustedIdentityName(observed: string, trustedNames: ReadonlySet<string>) {
  return [...trustedNames]
    .filter((name) => observed === name || observed.endsWith(name))
    .sort((left, right) => right.length - left.length)[0] ?? observed;
}

function identityPairKey(pair: { name: string; id: string }) {
  return `${pair.name}\u0000${pair.id}`;
}

function hasRoleFirstPersonPerspective(value: string) {
  return ROLE_FIRST_PERSON_SUBJECT_PATTERN.test(value)
    && !QUOTED_FIRST_PERSON_PATTERN.test(value)
    && !REPORTED_FIRST_PERSON_PATTERN.test(value);
}

function extractDigitRuns(value: string) {
  return value.match(/\d+/gu) ?? [];
}

function highRiskClaimsSupported(fact: string, sourceFacts: readonly string[]) {
  const canonical = fact.toLowerCase();
  const sources = sourceFacts.map((value) => value.toLowerCase());
  for (const term of HIGH_RISK_TERMS) {
    const canonicalSignatures = riskSignatures(canonical, term);
    if (!canonicalSignatures.length) continue;
    const sourceSignatures = new Set(sources.flatMap((source) => riskSignatures(source, term)));
    if (canonicalSignatures.some((signature) => !sourceSignatures.has(signature))) return false;
  }
  return true;
}

function riskSignatures(value: string, term: string) {
  const signatures: string[] = [];
  let cursor = 0;
  while (cursor <= value.length - term.length) {
    const index = value.indexOf(term, cursor);
    if (index < 0) break;
    const before = value.slice(Math.max(0, index - 12), index).replace(/[\s，。！？；：、,.!?;:]/gu, "");
    const after = value.slice(index + term.length, index + term.length + 12)
      .replace(/[\s，。！？；：、,.!?;:]/gu, "");
    const polarity = NEGATION_PATTERN.test(before) || ADVERSE_OUTCOME_PATTERN.test(after)
      ? "negated"
      : "affirmed";
    const modality = PLANNED_PATTERN.test(before)
      ? "planned"
      : COMPLETED_PATTERN.test(before) ? "completed" : "neutral";
    signatures.push(`${polarity}:${modality}`);
    cursor = index + term.length;
  }
  return signatures;
}

function sourceCoverage(
  fact: string,
  sourceFacts: readonly string[],
  trustedTokens: ReadonlySet<string>
) {
  const canonicalTokens = factTokens(fact);
  const sourceTokens = new Set(sourceFacts.flatMap(factTokens));
  const hasUnsupportedToken = canonicalTokens.some((token) => (
    !sourceTokens.has(token)
    && !SAFE_ADDITION_TOKENS.has(token)
    && !trustedTokens.has(token)
  ));
  const sourceBigrams = new Set(sourceFacts.flatMap(factBigrams));
  const evidenceBigrams = factBigrams(fact).filter((bigram) => {
    const [left, right] = splitBigram(bigram);
    return !isAllowedAddition(left, trustedTokens) || !isAllowedAddition(right, trustedTokens);
  });
  const matched = evidenceBigrams.filter((bigram) => sourceBigrams.has(bigram)).length;
  const hasUnsupportedContentBigram = evidenceBigrams.some((bigram) => {
    if (sourceBigrams.has(bigram)) return false;
    const [left, right] = splitBigram(bigram);
    return !isAllowedAddition(left, trustedTokens) && !isAllowedAddition(right, trustedTokens);
  });
  const ratio = evidenceBigrams.length
    ? matched / evidenceBigrams.length
    : canonicalTokens.every((token) => sourceTokens.has(token) || isAllowedAddition(token, trustedTokens)) ? 1 : 0;
  return {
    ratio,
    supported: !hasUnsupportedToken
      && !hasUnsupportedContentBigram
      && ratio >= DREAM_CANONICAL_MIN_SOURCE_BIGRAM_COVERAGE
  };
}

function factTokens(value: string) {
  return (value.normalize("NFKC").toLowerCase().match(TOKEN_PATTERN) ?? []).flatMap((token) => {
    if (/^[\p{Script=Han}]+$/u.test(token)) return Array.from(token);
    return [token];
  });
}

function tokenBigrams(tokens: readonly string[]) {
  return tokens.slice(1).map((token, index) => `${tokens[index]}\u0000${token}`);
}

function factBigrams(value: string) {
  return value
    .split(/[，。！？；：、,.!?;:\r\n]+/u)
    .flatMap((segment) => tokenBigrams(factTokens(segment)));
}

function splitBigram(value: string) {
  const separator = value.indexOf("\u0000");
  return [value.slice(0, separator), value.slice(separator + 1)] as const;
}

function isAllowedAddition(token: string, trustedTokens: ReadonlySet<string>) {
  return SAFE_ADDITION_TOKENS.has(token) || trustedTokens.has(token);
}
