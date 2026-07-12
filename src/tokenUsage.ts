export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cachedInput: number;
  cacheRate: number | null;
}

export interface TokenUsageMeasurement extends TokenUsage {
  cacheReported: boolean;
}

const MAX_TOKEN_COUNT = Number.MAX_SAFE_INTEGER;

const INPUT_KEYS = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "promptTokenCount"] as const;
const OUTPUT_KEYS = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"] as const;
const TOTAL_KEYS = ["total_tokens", "totalTokens", "totalTokenCount"] as const;
const CANDIDATE_KEYS = ["candidatesTokenCount", "candidateTokenCount", "responseTokenCount"] as const;
const THOUGHT_KEYS = ["thoughtsTokenCount", "thoughtTokenCount"] as const;
const TOOL_INPUT_KEYS = ["toolUsePromptTokenCount", "tool_use_prompt_token_count"] as const;
const CACHE_READ_KEYS = [
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cached_input_tokens",
  "cachedInputTokens",
  "cachedContentTokenCount",
  "prompt_cache_hit_tokens",
  "promptCacheHitTokens"
] as const;
const CACHE_MISS_KEYS = ["prompt_cache_miss_tokens", "promptCacheMissTokens"] as const;
const CACHE_DETAIL_READ_KEYS = ["cached_tokens", "cachedTokens", "cache_read_tokens", "cacheReadTokens"] as const;
const CACHE_WRITE_KEYS = [
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cache_write_input_tokens",
  "cacheWriteInputTokens",
  "cache_write_tokens",
  "cacheWriteTokens"
] as const;
const CACHE_CREATION_DETAIL_KEYS = ["ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens"] as const;

export function normalizeTokenUsageRecord(record: Record<string, unknown>): TokenUsageMeasurement | undefined {
  const response = asRecord(record.response);
  const summary = asRecord(response?.summary);
  const usage = asRecord(summary?.usage) ?? asRecord(response?.usage);
  if (!usage) return normalizeStoredTokenUsage(asRecord(record.tokenUsage));

  const inputValue = readFirst(usage, INPUT_KEYS);
  const outputValue = readFirst(usage, OUTPUT_KEYS);
  const totalValue = readFirst(usage, TOTAL_KEYS);
  const candidateValue = readFirst(usage, CANDIDATE_KEYS);
  const thoughtValue = readFirst(usage, THOUGHT_KEYS);
  const toolInputValue = readFirst(usage, TOOL_INPUT_KEYS);
  const inputDetails = asRecord(usage.input_tokens_details ?? usage.inputTokensDetails);
  const promptDetails = asRecord(usage.prompt_tokens_details ?? usage.promptTokensDetails);
  const cacheRead = firstPresent(
    readFirst(usage, CACHE_READ_KEYS),
    readFirst(inputDetails, CACHE_DETAIL_READ_KEYS),
    readFirst(promptDetails, CACHE_DETAIL_READ_KEYS)
  );
  const directCacheWrite = firstPresent(
    readFirst(usage, CACHE_WRITE_KEYS),
    readFirst(inputDetails, CACHE_WRITE_KEYS),
    readFirst(promptDetails, CACHE_WRITE_KEYS)
  );
  const cacheCreation = asRecord(usage.cache_creation ?? usage.cacheCreation);
  const cacheCreationBreakdown = sumPresent(cacheCreation, CACHE_CREATION_DETAIL_KEYS);
  const cacheWrite = directCacheWrite.present ? directCacheWrite : cacheCreationBreakdown;
  const cacheMiss = readFirst(usage, CACHE_MISS_KEYS);
  const cacheReported = cacheRead.present || cacheWrite.present || cacheMiss.present;

  if (![
    inputValue,
    outputValue,
    totalValue,
    candidateValue,
    thoughtValue,
    toolInputValue,
    cacheRead,
    cacheWrite,
    cacheMiss
  ].some((value) => value.present)) return undefined;

  const providerKind = String(record.providerKind ?? "").toLowerCase();
  const action = String(record.action ?? "").toLowerCase();
  const anthropicInputIsExclusive = providerKind.startsWith("anthropic") ||
    action.startsWith("anthropic.") ||
    hasOwn(usage, "cache_read_input_tokens") ||
    hasOwn(usage, "cacheReadInputTokens") ||
    hasOwn(usage, "cache_creation_input_tokens") ||
    hasOwn(usage, "cacheCreationInputTokens") ||
    Boolean(cacheCreation);
  const geminiUsage = providerKind.startsWith("gemini") ||
    action.startsWith("gemini.") ||
    candidateValue.present ||
    thoughtValue.present ||
    toolInputValue.present ||
    hasOwn(usage, "promptTokenCount");
  const codexCliUsage = providerKind === "codex-cli" || action === "codex.tool.complete";

  const ordinaryInput = sumTokenCounts(inputValue.value, geminiUsage ? toolInputValue.value : 0);
  const cacheAccountedInput = sumTokenCounts(cacheRead.value, cacheWrite.value);
  const input = anthropicInputIsExclusive
    ? sumTokenCounts(ordinaryInput, cacheAccountedInput)
    : ordinaryInput;
  const output = geminiUsage
    ? sumTokenCounts(candidateValue.value, thoughtValue.value)
    : outputValue.value;
  const cachedInput = Math.min(cacheRead.value, input);
  const derivedTotal = sumTokenCounts(input, output);
  const total = anthropicInputIsExclusive || codexCliUsage
    ? derivedTotal
    : Math.max(totalValue.value, derivedTotal);
  const cacheRate = cacheReported
    ? input > 0 ? clampRate(cachedInput / input) : 0
    : null;

  return { input, output, total, cachedInput, cacheRate, cacheReported };
}

export function publicTokenUsage(usage: TokenUsageMeasurement): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cachedInput: usage.cachedInput,
    cacheRate: usage.cacheRate
  };
}

function normalizeStoredTokenUsage(usage: Record<string, unknown> | undefined): TokenUsageMeasurement | undefined {
  if (!usage) return undefined;
  const input = readFirst(usage, ["input"]);
  const output = readFirst(usage, ["output"]);
  const total = readFirst(usage, ["total"]);
  const cachedInputValue = readFirst(usage, ["cachedInput"]);
  if (![input, output, total, cachedInputValue].some((value) => value.present)) return undefined;
  const cachedInput = Math.min(cachedInputValue.value, input.value);
  const rawCacheRate = usage.cacheRate;
  const cacheReported = typeof rawCacheRate === "number" && Number.isFinite(rawCacheRate);
  return {
    input: input.value,
    output: output.value,
    total: Math.max(total.value, sumTokenCounts(input.value, output.value)),
    cachedInput,
    cacheRate: cacheReported ? (input.value > 0 ? clampRate(cachedInput / input.value) : 0) : null,
    cacheReported
  };
}

interface PresentNumber {
  present: boolean;
  value: number;
}

function readFirst(record: Record<string, unknown> | undefined, keys: readonly string[]): PresentNumber {
  if (!record) return { present: false, value: 0 };
  for (const key of keys) {
    if (hasOwn(record, key)) return { present: true, value: tokenNumber(record[key]) };
  }
  return { present: false, value: 0 };
}

function firstPresent(...values: PresentNumber[]) {
  return values.find((value) => value.present) ?? { present: false, value: 0 };
}

function sumPresent(record: Record<string, unknown> | undefined, keys: readonly string[]): PresentNumber {
  if (!record) return { present: false, value: 0 };
  let present = false;
  let value = 0;
  for (const key of keys) {
    if (!hasOwn(record, key)) continue;
    present = true;
    value = sumTokenCounts(value, tokenNumber(record[key]));
  }
  return { present, value };
}

function tokenNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0
    ? Math.min(Math.trunc(number), MAX_TOKEN_COUNT)
    : 0;
}

export function sumTokenCounts(...values: number[]) {
  let total = 0;
  for (const value of values) {
    const normalized = Number.isFinite(value) && value > 0
      ? Math.min(Math.trunc(value), MAX_TOKEN_COUNT)
      : 0;
    if (normalized >= MAX_TOKEN_COUNT - total) return MAX_TOKEN_COUNT;
    total += normalized;
  }
  return total;
}

function clampRate(value: number) {
  return Math.min(Math.max(value, 0), 1);
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
