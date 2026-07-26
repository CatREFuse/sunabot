export const CODEX_MAX_STDOUT_BYTES = 4 * 1024 * 1024;
export const CODEX_MAX_JSONL_LINE_BYTES = 1024 * 1024;

export interface CodexJsonlSnapshot {
  threadId?: string;
  turnStarted: boolean;
  turnCompleted: boolean;
  turnFailed: boolean;
  failureMessage?: string;
  lastAgentText?: string;
  usage?: Record<string, number>;
  errorMessages: string[];
  itemTypes: string[];
  outputTruncated: boolean;
  outputBytes: number;
}

export class CodexJsonlLifecycleParser {
  private buffer = "";
  private totalBytes = 0;
  private state: CodexJsonlSnapshot = {
    turnStarted: false,
    turnCompleted: false,
      turnFailed: false,
      errorMessages: [],
      itemTypes: [],
      outputTruncated: false,
      outputBytes: 0
  };

  get snapshot(): CodexJsonlSnapshot {
    return {
      ...this.state,
      errorMessages: this.state.errorMessages.slice(),
      itemTypes: this.state.itemTypes.slice(),
      usage: this.state.usage ? { ...this.state.usage } : undefined
    };
  }

  push(chunk: Buffer | string) {
    const text = String(chunk);
    this.totalBytes += Buffer.byteLength(text);
    this.state.outputBytes = this.totalBytes;
    if (this.totalBytes > CODEX_MAX_STDOUT_BYTES) this.state.outputTruncated = true;
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.parseLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.buffer) > CODEX_MAX_JSONL_LINE_BYTES) {
      throw new CodexProtocolError("jsonl_line_limit", `Codex JSONL line exceeded ${CODEX_MAX_JSONL_LINE_BYTES} bytes.`);
    }
  }

  finish() {
    const finalLine = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    if (finalLine.trim()) this.parseLine(finalLine);
  }

  private parseLine(line: string) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > CODEX_MAX_JSONL_LINE_BYTES) {
      throw new CodexProtocolError("jsonl_line_limit", `Codex JSONL line exceeded ${CODEX_MAX_JSONL_LINE_BYTES} bytes.`);
    }
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("event must be an object");
      event = parsed as Record<string, unknown>;
    } catch (error) {
      throw new CodexProtocolError("invalid_jsonl", `Invalid Codex JSONL: ${errorMessage(error)}`);
    }

    const type = String(event.type ?? "");
    if (type === "thread.started") {
      const threadId = String(event.thread_id ?? "").trim();
      if (!threadId) throw new CodexProtocolError("invalid_thread_event", "Codex thread.started omitted thread_id.");
      this.state.threadId = threadId;
      return;
    }
    if (type === "turn.started") {
      this.state.turnStarted = true;
      return;
    }
    if (type === "turn.completed") {
      if (this.state.turnFailed) {
        throw new CodexProtocolError("conflicting_terminal_event", "Codex emitted both completed and failed terminals.");
      }
      this.state.turnCompleted = true;
      this.state.usage = numericRecord(event.usage);
      return;
    }
    if (type === "turn.failed") {
      if (this.state.turnCompleted) {
        throw new CodexProtocolError("conflicting_terminal_event", "Codex emitted both completed and failed terminals.");
      }
      this.state.turnFailed = true;
      this.state.failureMessage = nestedMessage(event.error);
      return;
    }
    if (type === "error") {
      const message = String(event.message ?? "Codex reported an error.").trim();
      if (message) {
        this.state.errorMessages.push(message.slice(0, 4_000));
        if (this.state.errorMessages.length > 64) this.state.errorMessages.shift();
      }
      return;
    }
    if (type === "item.started" || type === "item.completed") {
      const item = readRecord(event.item);
      const itemType = String(item.type ?? "unknown");
      if (this.state.itemTypes.length < 256) this.state.itemTypes.push(itemType);
      if (type === "item.completed" && itemType === "agent_message") {
        const text = String(item.text ?? "").trim();
        if (text) this.state.lastAgentText = text;
      }
    }
  }
}

export class CodexProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodexProtocolError";
  }
}

function nestedMessage(value: unknown) {
  const record = readRecord(value);
  return String(record.message ?? "").trim() || undefined;
}

function numericRecord(value: unknown) {
  const record = readRecord(value);
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "number" && Number.isFinite(item)) result[key] = item;
  }
  return Object.keys(result).length ? result : undefined;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "Unknown error");
}
