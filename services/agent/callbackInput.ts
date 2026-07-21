const CALLBACK_INPUT_OPEN = "<sunabot_callback_input>";
const CALLBACK_INPUT_CLOSE = "</sunabot_callback_input>";
export interface CallbackInputEnvelope {
  schemaVersion: 1;
  role: "callback";
  kind: string;
  payload: unknown;
}

export function buildCallbackInput(kind: string, payload: unknown) {
  const envelope: CallbackInputEnvelope = {
    schemaVersion: 1,
    role: "callback",
    kind: requiredKind(kind),
    payload
  };
  return `${CALLBACK_INPUT_OPEN}\n${JSON.stringify(envelope, null, 2)}\n${CALLBACK_INPUT_CLOSE}`;
}

export function readCallbackInput(value: string): CallbackInputEnvelope | undefined {
  if (typeof value !== "string") return undefined;
  const start = value.indexOf(CALLBACK_INPUT_OPEN);
  const end = value.lastIndexOf(CALLBACK_INPUT_CLOSE);
  if (start < 0 || end <= start) return undefined;
  const encoded = value.slice(start + CALLBACK_INPUT_OPEN.length, end).trim();
  try {
    const parsed = JSON.parse(encoded) as Record<string, unknown>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.role !== "callback" ||
      typeof parsed.kind !== "string" ||
      !parsed.kind.trim() ||
      !Object.hasOwn(parsed, "payload")
    ) return undefined;
    return {
      schemaVersion: 1,
      role: "callback",
      kind: parsed.kind.trim(),
      payload: parsed.payload
    };
  } catch {
    return undefined;
  }
}

function requiredKind(value: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 80) throw new Error("Callback input kind is invalid.");
  return normalized;
}
