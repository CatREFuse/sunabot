export interface OutboxBubbleSequenceV1 {
  schemaVersion: 1;
  index: number;
  total: number;
}

export function decodeOutboxBubbleSequence(value: unknown): OutboxBubbleSequenceV1 | undefined {
  if (value == null) return undefined;
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "index,schemaVersion,total"
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.index)
    || !Number.isSafeInteger(value.total)
    || Number(value.total) < 2
    || Number(value.index) < 0
    || Number(value.index) >= Number(value.total)) {
    throw invalidField("bubbleSequence");
  }
  return {
    schemaVersion: 1,
    index: Number(value.index),
    total: Number(value.total)
  };
}

export function decodeMentionUserIds(value: unknown) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 20) throw invalidField("mentionUserIds");
  const values = value.map((item) => {
    if (!Number.isSafeInteger(item) || Number(item) <= 0) throw invalidField("mentionUserIds");
    return Number(item);
  });
  if (new Set(values).size !== values.length) throw invalidField("mentionUserIds");
  return values;
}

function invalidField(name: string) {
  return Object.assign(new Error(`持久化消息字段 ${name} 无效。`), {
    code: "contract_field_invalid"
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
