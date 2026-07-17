import { createHash, randomBytes } from "node:crypto";
import { redactMcpHostPaths } from "../../packages/contracts/extensions/mcpExternalData.js";
import { assertBoundedMcpToolArguments } from "./mcpJsonLimits.js";

export const MCP_TOOL_APPROVAL_TTL_MS = 10 * 60 * 1000;
export const MCP_TOOL_APPROVAL_MAX_PENDING = 256;
export const MCP_TOOL_APPROVAL_ARGUMENT_MAX_BYTES = 16 * 1024;
export const MCP_TOOL_APPROVAL_ARGUMENT_MAX_DEPTH = 12;
export const MCP_TOOL_APPROVAL_ARGUMENT_MAX_NODES = 512;

export type McpToolApprovalMode = "never" | "always" | "mutating";

export interface McpToolApprovalRequest {
  agentId: string;
  accountId: string;
  transport: "onebot" | "web";
  conversationId: string;
  userId: number;
  serverId: string;
  toolName: string;
  snapshotDigest: string;
  catalogGeneration: number;
  arguments: Record<string, unknown>;
  approvalMode: McpToolApprovalMode;
  callId: string;
}

export interface McpToolApprovalContext {
  agentId: string;
  accountId: string;
  transport: "onebot" | "web";
  conversationId: string;
  userId: number;
}

export interface McpToolApprovalRequired {
  ok: false;
  approvalRequired: true;
  approvalId: string;
  expiresAt: string;
  confirmationText: string;
  summary: string;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  argumentsDigest: string;
}

interface NormalizedApprovalRequest extends Omit<McpToolApprovalRequest, "arguments"> {
  arguments: Record<string, unknown>;
  argumentsDigest: string;
  displayArguments: Record<string, unknown>;
}

interface ApprovalTicket {
  id: string;
  fingerprint: string;
  agentId: string;
  accountId: string;
  transport: "onebot" | "web";
  conversationId: string;
  userId: number;
  serverId: string;
  toolName: string;
  snapshotDigest: string;
  catalogGeneration: number;
  argumentsDigest: string;
  arguments: Record<string, unknown>;
  callId: string;
  createdAt: number;
  expiresAt: number;
  approvedAt?: number;
}

export class McpToolApprovalTransactions {
  private readonly tickets = new Map<string, ApprovalTicket>();
  private readonly byFingerprint = new Map<string, string>();

  constructor(private readonly options: {
    now?: () => number;
    ttlMs?: number;
    maxPending?: number;
  } = {}) {}

  resolve(input: McpToolApprovalRequest) {
    const normalized = normalizeRequest(input);
    if (normalized.approvalMode === "never") return true;
    this.prune();
    const fingerprint = approvalFingerprint(normalized);
    const existingId = this.byFingerprint.get(fingerprint);
    const existing = existingId ? this.tickets.get(existingId) : undefined;
    if (existing?.approvedAt !== undefined) {
      this.delete(existing);
      return true;
    }
    if (existing) return required(existing);
    if (this.tickets.size >= (this.options.maxPending ?? MCP_TOOL_APPROVAL_MAX_PENDING)) {
      throw new Error("MCP_TOOL_APPROVAL_QUEUE_FULL");
    }
    const now = this.now();
    const ticket: ApprovalTicket = {
      id: `mcpa_${randomBytes(18).toString("base64url")}`,
      fingerprint,
      agentId: normalized.agentId,
      accountId: normalized.accountId,
      transport: normalized.transport,
      conversationId: normalized.conversationId,
      userId: normalized.userId,
      serverId: normalized.serverId,
      toolName: normalized.toolName,
      snapshotDigest: normalized.snapshotDigest,
      catalogGeneration: normalized.catalogGeneration,
      argumentsDigest: normalized.argumentsDigest,
      arguments: normalized.displayArguments,
      callId: normalized.callId,
      createdAt: now,
      expiresAt: now + (this.options.ttlMs ?? MCP_TOOL_APPROVAL_TTL_MS)
    };
    this.tickets.set(ticket.id, ticket);
    this.byFingerprint.set(ticket.fingerprint, ticket.id);
    return required(ticket);
  }

  confirm(text: string, context: McpToolApprovalContext) {
    const id = typeof text === "string"
      ? text.trim().match(/^\/确认\s+MCP\s+(mcpa_[A-Za-z0-9_-]{24})$/iu)?.[1]
      : undefined;
    if (!id) return false;
    const normalized = normalizeContext(context);
    this.prune();
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.approvedAt !== undefined || ticket.agentId !== normalized.agentId ||
        ticket.accountId !== normalized.accountId || ticket.transport !== normalized.transport ||
        ticket.conversationId !== normalized.conversationId || ticket.userId !== normalized.userId) return false;
    ticket.approvedAt = this.now();
    return true;
  }

  list(agentId: string) {
    const normalizedAgentId = identifier(agentId);
    this.prune();
    return [...this.tickets.values()]
      .filter((ticket) => ticket.agentId === normalizedAgentId)
      .sort((left, right) => left.createdAt - right.createdAt || compareText(left.id, right.id))
      .map((ticket) => ({
        id: ticket.id,
        agentId: ticket.agentId,
        accountId: ticket.accountId,
        transport: ticket.transport,
        conversationId: ticket.conversationId,
        userId: ticket.userId,
        serverId: ticket.serverId,
        toolName: ticket.toolName,
        snapshotDigest: ticket.snapshotDigest,
        catalogGeneration: ticket.catalogGeneration,
        argumentsDigest: ticket.argumentsDigest,
        arguments: cloneArguments(ticket.arguments),
        status: ticket.approvedAt === undefined ? "pending" as const : "approved" as const,
        createdAt: new Date(ticket.createdAt).toISOString(),
        expiresAt: new Date(ticket.expiresAt).toISOString()
      }));
  }

  approve(input: { agentId: string; ticketId: string }) {
    const agentId = identifier(input.agentId);
    const ticketId = approvalId(input.ticketId);
    this.prune();
    const ticket = this.tickets.get(ticketId);
    if (!ticket || ticket.agentId !== agentId || ticket.approvedAt !== undefined) {
      throw new Error("MCP_TOOL_APPROVAL_NOT_FOUND");
    }
    ticket.approvedAt = this.now();
    return { ok: true as const };
  }

  clearConversation(agentId: string, conversationId: string) {
    for (const ticket of this.tickets.values()) {
      if (ticket.agentId === agentId && ticket.conversationId === conversationId) this.delete(ticket);
    }
  }

  clearAgent(agentId: string) {
    for (const ticket of this.tickets.values()) {
      if (ticket.agentId === agentId) this.delete(ticket);
    }
  }

  clear() {
    this.tickets.clear();
    this.byFingerprint.clear();
  }

  private prune() {
    const now = this.now();
    for (const ticket of this.tickets.values()) {
      if (ticket.expiresAt <= now) this.delete(ticket);
    }
  }

  private delete(ticket: ApprovalTicket) {
    this.tickets.delete(ticket.id);
    if (this.byFingerprint.get(ticket.fingerprint) === ticket.id) this.byFingerprint.delete(ticket.fingerprint);
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}

function normalizeRequest(input: McpToolApprovalRequest): NormalizedApprovalRequest {
  assertBoundedMcpToolArguments(input.arguments);
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0 ||
      !Number.isSafeInteger(input.catalogGeneration) || input.catalogGeneration <= 0 ||
      !/^[a-f0-9]{64}$/u.test(input.snapshotDigest) ||
      !["never", "always", "mutating"].includes(input.approvalMode)) invalid();
  const canonicalArguments = canonicalJson(input.arguments);
  assertBoundedApprovalArguments(input.arguments, canonicalArguments);
  const argumentsSnapshot = JSON.parse(canonicalArguments) as Record<string, unknown>;
  const argumentsDigest = digestCanonicalArguments(canonicalArguments);
  return {
    agentId: identifier(input.agentId),
    accountId: identifier(input.accountId),
    transport: input.transport === "web" ? "web" : input.transport === "onebot" ? "onebot" : invalid(),
    conversationId: identifier(input.conversationId, 256),
    userId: input.userId,
    serverId: identifier(input.serverId),
    toolName: identifier(input.toolName, 256),
    snapshotDigest: input.snapshotDigest,
    catalogGeneration: input.catalogGeneration,
    arguments: argumentsSnapshot,
    argumentsDigest,
    displayArguments: sanitizeApprovalArguments(argumentsSnapshot),
    approvalMode: input.approvalMode,
    callId: identifier(input.callId, 256)
  };
}

function normalizeContext(input: McpToolApprovalContext): McpToolApprovalContext {
  if (!Number.isSafeInteger(input.userId) || input.userId <= 0) invalid();
  return {
    agentId: identifier(input.agentId),
    accountId: identifier(input.accountId),
    transport: input.transport === "web" ? "web" : input.transport === "onebot" ? "onebot" : invalid(),
    conversationId: identifier(input.conversationId, 256),
    userId: input.userId
  };
}

function approvalFingerprint(input: NormalizedApprovalRequest) {
  return createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    agentId: input.agentId,
    accountId: input.accountId,
    transport: input.transport,
    conversationId: input.conversationId,
    userId: input.userId,
    serverId: input.serverId,
    toolName: input.toolName,
    snapshotDigest: input.snapshotDigest,
    catalogGeneration: input.catalogGeneration,
    argumentsDigest: input.argumentsDigest
  })).digest("hex");
}

function digestCanonicalArguments(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function required(ticket: ApprovalTicket): McpToolApprovalRequired {
  return {
    ok: false,
    approvalRequired: true,
    approvalId: ticket.id,
    expiresAt: new Date(ticket.expiresAt).toISOString(),
    confirmationText: `/确认 MCP ${ticket.id}`,
    summary: `MCP ${ticket.serverId}/${ticket.toolName}`,
    serverId: ticket.serverId,
    toolName: ticket.toolName,
    arguments: cloneArguments(ticket.arguments),
    argumentsDigest: ticket.argumentsDigest
  };
}

function sanitizeApprovalArguments(value: Record<string, unknown>) {
  const sanitized = sanitizeApprovalValue(value, undefined) as Record<string, unknown>;
  assertBoundedMcpToolArguments(sanitized);
  return sanitized;
}

function sanitizeApprovalValue(value: unknown, parentKey: string | undefined): unknown {
  if (parentKey && sensitiveArgumentKey(parentKey)) return "[REDACTED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return redactMcpHostPaths(redactCredentialValues(
      value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "")
    ));
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeApprovalValue(item, parentKey));
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value as Record<string, unknown>).sort(compareText)) {
    const safeKey = redactMcpHostPaths(key.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, ""));
    if (!safeKey || Object.prototype.hasOwnProperty.call(output, safeKey)) invalid();
    output[safeKey] = sanitizeApprovalValue((value as Record<string, unknown>)[key], key);
  }
  return output;
}

function sensitiveArgumentKey(value: string) {
  const key = value.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return key === "key" || key === "cert" || key === "netrc" ||
    /^(?:authorization|cookie|bearer|password|passwd|token|secret|credential|certificate)$/u.test(key) ||
    /^(?:api|access|refresh|identity|private|client|session|oauth|xapi|x)(?:key|token|secret|password|cookie|credential)$/u
      .test(key) || /(?:^|[-_])(?:authorization|cookie|api[-_]?key|token|secret|credential)(?:$|[-_])/iu.test(value);
}

function redactCredentialValues(value: string) {
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u.test(value) || highEntropyCredential(value)) {
    return "[REDACTED]";
  }
  return value
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, "[REDACTED]");
}

function highEntropyCredential(value: string) {
  if (value.length < 48 || value.length > 4_096 || /\s/u.test(value)) return false;
  if (/^[a-f0-9]{64,}$/iu.test(value)) return true;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[-_+/=]/u].filter((pattern) => pattern.test(value)).length;
  return classes >= 3 && new Set(value).size / value.length >= 0.35;
}

function assertBoundedApprovalArguments(value: Record<string, unknown>, canonical: string) {
  if (Buffer.byteLength(canonical, "utf8") > MCP_TOOL_APPROVAL_ARGUMENT_MAX_BYTES) approvalArgumentsLimit();
  const pending = [{ value: value as unknown, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MCP_TOOL_APPROVAL_ARGUMENT_MAX_NODES || current.depth > MCP_TOOL_APPROVAL_ARGUMENT_MAX_DEPTH) {
      approvalArgumentsLimit();
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) pending.push({ value: item, depth: current.depth + 1 });
    } else if (current.value && typeof current.value === "object") {
      for (const item of Object.values(current.value)) pending.push({ value: item, depth: current.depth + 1 });
    }
  }
}

function cloneArguments(value: Record<string, unknown>) {
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(compareText).map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function identifier(value: string, max = 128) {
  if (typeof value !== "string" || !value || value.length > max || value.includes("\0")) invalid();
  return value;
}

function approvalId(value: string) {
  if (!/^mcpa_[A-Za-z0-9_-]{24}$/u.test(value)) invalid();
  return value;
}

function compareText(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right));
}

function invalid(): never {
  throw new Error("MCP_TOOL_APPROVAL_INVALID");
}

function approvalArgumentsLimit(): never {
  throw new Error("MCP_TOOL_APPROVAL_ARGUMENTS_LIMIT");
}
