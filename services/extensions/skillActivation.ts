import {
  SKILL_ACTIVATION_MAX_INSTRUCTION_CHARS,
  SKILL_ACTIVATION_MAX_INSTRUCTION_BYTES,
  SKILL_ACTIVATION_MAX_CONVERSATION_BYTES,
  SKILL_ACTIVATION_MAX_RESOURCES,
  SKILL_SCRIPT_MAX_RESULT_BYTES,
  assertSkillActivationResource,
  isRuntimeApprovedSkill,
  type SkillActivationResource,
  type SkillActivationResult
} from "../../packages/contracts/extensions/agentRuntimeExtensions.js";
import type { AgentSkillRecord } from "../../packages/contracts/extensions/agentExtensions.js";

const MAX_ACTIVE_CONVERSATIONS = 128;
const MAX_ACTIVE_SKILLS_PER_CONVERSATION = 32;

interface ActivatedSkill {
  result: SkillActivationResult;
  scriptBearing: boolean;
}

interface ActivatedSession {
  skills: Map<string, ActivatedSkill>;
  injectedBytes: number;
  reservedBytes: number;
}

interface ActiveScriptExecution {
  controller: AbortController;
  promise: Promise<unknown>;
  cleanupFailed: boolean;
}

const SCRIPT_LIFECYCLE_CLOSE_TIMEOUT_MS = 10_000;

export interface RuntimeSkillReadResult {
  digestSha256: string;
  instructions: string;
  resources: SkillActivationResource[];
}

export interface RuntimeSkillReaderPort {
  read(input: {
    agentId: string;
    skillId: string;
    expectedDigestSha256: string;
  }): Promise<RuntimeSkillReadResult>;
  readResource?(input: {
    agentId: string;
    skillId: string;
    expectedDigestSha256: string;
    resource: SkillActivationResource;
  }): Promise<{ bytes: Uint8Array; sha256: string }>;
}

export interface RuntimeSkillScriptExecutorPort {
  run(input: {
    agentId: string;
    conversationId: string;
    skillId: string;
    expectedDigestSha256: string;
    resource: SkillActivationResource;
    args: string[];
    signal?: AbortSignal;
    outputBudgetBytes: number;
  }): Promise<unknown>;
}

export class SkillActivationService {
  private readonly activated = new Map<string, ActivatedSession>();
  private readonly activationFlights = new Map<string, Promise<SkillActivationResult>>();
  private readonly activationTails = new Map<string, Promise<void>>();
  private readonly activeScripts = new Map<string, Map<number, ActiveScriptExecution>>();
  private capacityTail = Promise.resolve();
  private scriptSequence = 0;

  constructor(
    private readonly reader: RuntimeSkillReaderPort,
    private readonly scriptExecutor?: RuntimeSkillScriptExecutorPort
  ) {}

  async activate(input: {
    agentId: string;
    conversationId: string;
    skillId: string;
    skills: AgentSkillRecord[];
  }): Promise<SkillActivationResult> {
    const record = input.skills.find((skill) => skill.id === input.skillId);
    if (!record || !isRuntimeApprovedSkill(record)) throw new Error("SKILL_UNAVAILABLE");
    const key = sessionKey(input.agentId, input.conversationId);
    const flightKey = activationFlightKey(key, record);
    const existingFlight = this.activationFlights.get(flightKey);
    if (existingFlight) {
      return existingFlight.then((result) => ({ ...result, alreadyActivated: true }));
    }
    const operation = this.withActivationLock(key, () => this.activateLocked(input, key, record));
    const tracked = operation.finally(() => {
      if (this.activationFlights.get(flightKey) === tracked) this.activationFlights.delete(flightKey);
    });
    this.activationFlights.set(flightKey, tracked);
    return tracked;
  }

  private async activateLocked(
    input: { agentId: string; conversationId: string; skillId: string; skills: AgentSkillRecord[] },
    key: string,
    record: AgentSkillRecord
  ) {
    if (!isRuntimeApprovedSkill(record) || input.skills.find((skill) => skill.id === input.skillId) !== record) {
      throw new Error("SKILL_UNAVAILABLE");
    }
    const admitted = await this.admitSession(key);
    const session = admitted.session;
    try {
      return await this.activateInSession(input, key, record, session);
    } catch (error) {
      if (admitted.created) await this.releaseEmptyAdmission(key, session);
      throw error;
    }
  }

  private async activateInSession(
    input: { agentId: string; conversationId: string; skillId: string; skills: AgentSkillRecord[] },
    key: string,
    record: AgentSkillRecord,
    session: ActivatedSession
  ) {
    const scriptBearing = record.riskEvidence.classification === "script-bearing" &&
      record.riskEvidence.hasScripts === true;
    const existing = session.skills.get(record.id);
    if (existing) {
      if (existing.result.digestSha256 !== record.digestSha256 || existing.scriptBearing !== scriptBearing) {
        throw new Error("SKILL_RUNTIME_INVALID");
      }
      await this.touchSessionLocked(key, session);
      return { ...existing.result, alreadyActivated: true };
    }
    if (session.skills.size >= MAX_ACTIVE_SKILLS_PER_CONVERSATION) throw new Error("SKILL_SESSION_LIMIT");

    const read = await this.reader.read({
      agentId: input.agentId,
      skillId: record.id,
      expectedDigestSha256: record.digestSha256
    });
    if (read.digestSha256 !== record.digestSha256 || !read.instructions ||
        read.instructions.length > SKILL_ACTIVATION_MAX_INSTRUCTION_CHARS ||
        Buffer.byteLength(read.instructions, "utf8") > SKILL_ACTIVATION_MAX_INSTRUCTION_BYTES ||
        read.instructions.includes("\0") || read.resources.length > SKILL_ACTIVATION_MAX_RESOURCES) {
      throw new Error("SKILL_RUNTIME_INVALID");
    }
    const resources = read.resources.map((resource) => ({ ...assertSkillActivationResource(resource) }));
    if (new Set(resources.map((resource) => resource.path)).size !== resources.length) {
      throw new Error("SKILL_RUNTIME_INVALID");
    }
    const result: SkillActivationResult = {
      skillId: record.id,
      digestSha256: record.digestSha256,
      virtualDirectory: `/skills/${record.id}`,
      instructions: read.instructions,
      resources: resources.sort((left, right) => left.path.localeCompare(right.path, "en")),
      alreadyActivated: false
    };
    chargeSession(session, result);
    session.skills.set(record.id, {
      result,
      scriptBearing
    });
    await this.touchSessionLocked(key, session);
    return result;
  }

  async readResource(input: {
    agentId: string;
    conversationId: string;
    skillId: string;
    path: string;
  }) {
    const activated = this.requireActivation(input.agentId, input.conversationId, input.skillId);
    const resource = activated.result.resources.find((candidate) => candidate.path === input.path);
    if (!resource || !this.reader.readResource) throw new Error("SKILL_RESOURCE_UNAVAILABLE");
    const reservation = reserveSession(
      this.requireSession(input.agentId, input.conversationId),
      Math.ceil(resource.bytes * 4 / 3) + 2_048
    );
    try {
      const read = await this.reader.readResource({
        agentId: input.agentId,
        skillId: input.skillId,
        expectedDigestSha256: activated.result.digestSha256,
        resource
      });
      try {
        if (read.sha256 !== resource.sha256 || read.bytes.byteLength !== resource.bytes) {
          throw new Error("SKILL_RUNTIME_INVALID");
        }
        const text = decodeResourceText(read.bytes);
        const result = {
          ok: true,
          skillId: input.skillId,
          path: resource.path,
          sha256: resource.sha256,
          byteLength: resource.bytes,
          encoding: text === undefined ? "base64" as const : "utf8" as const,
          content: text ?? Buffer.from(read.bytes).toString("base64")
        };
        reservation.commit(result);
        return result;
      } finally {
        read.bytes.fill(0);
      }
    } catch (error) {
      reservation.release();
      throw error;
    }
  }

  runScript(input: {
    agentId: string;
    conversationId: string;
    skillId: string;
    path: string;
    args: string[];
    signal?: AbortSignal;
  }) {
    const activated = this.requireActivation(input.agentId, input.conversationId, input.skillId);
    const resource = activated.result.resources.find((candidate) => candidate.path === input.path);
    if (!this.scriptExecutor || !activated.scriptBearing || !resource || !resource.path.startsWith("scripts/")) {
      throw new Error("SKILL_SCRIPT_UNAVAILABLE");
    }
    const reservation = reserveSession(
      this.requireSession(input.agentId, input.conversationId),
      SKILL_SCRIPT_MAX_RESULT_BYTES
    );
    const key = sessionKey(input.agentId, input.conversationId);
    const id = ++this.scriptSequence;
    const controller = new AbortController();
    const removeTurnAbort = relayAbort(input.signal, controller);
    const execution: ActiveScriptExecution = {
      controller,
      promise: Promise.resolve(),
      cleanupFailed: false
    };
    const scripts = this.activeScripts.get(key) ?? new Map<number, ActiveScriptExecution>();
    scripts.set(id, execution);
    this.activeScripts.set(key, scripts);
    const operation = Promise.resolve().then(() => this.scriptExecutor!.run({
      agentId: input.agentId,
      conversationId: input.conversationId,
      skillId: input.skillId,
      expectedDigestSha256: activated.result.digestSha256,
      resource,
      args: [...input.args],
      signal: controller.signal,
      outputBudgetBytes: SKILL_SCRIPT_MAX_RESULT_BYTES
    })).then((result) => {
      if (controller.signal.aborted) throw new Error("SKILL_SCRIPT_ABORTED");
      const bounded = boundedSuccessfulScriptResult(result, SKILL_SCRIPT_MAX_RESULT_BYTES);
      reservation.commit(bounded);
      return bounded;
    }).catch((error) => {
      reservation.release();
      execution.cleanupFailed = error instanceof Error && error.message === "SKILL_SCRIPT_CLEANUP_FAILED";
      throw error;
    }).finally(() => {
      removeTurnAbort();
      if (!execution.cleanupFailed && scripts.get(id) === execution) {
        scripts.delete(id);
        if (!scripts.size && this.activeScripts.get(key) === scripts) this.activeScripts.delete(key);
      }
    });
    execution.promise = operation;
    return operation;
  }

  protectedInstructions(agentId: string, conversationId: string) {
    const session = this.activated.get(sessionKey(agentId, conversationId));
    if (!session?.skills.size) return [];
    return [...session.skills.values()].map(({ result: activation }) => ({
      skillId: activation.skillId,
      digestSha256: activation.digestSha256,
      protected: true as const,
      text: activation.instructions
    }));
  }

  async clearConversation(agentId: string, conversationId: string) {
    await this.abortScripts((key) => key === sessionKey(agentId, conversationId));
    this.activated.delete(sessionKey(agentId, conversationId));
  }

  async clearAgent(agentId: string) {
    await this.abortScripts((key) => key.startsWith(`${agentId}\0`));
    for (const key of this.activated.keys()) {
      if (key.startsWith(`${agentId}\0`)) this.activated.delete(key);
    }
  }

  async clear() {
    await this.abortScripts(() => true);
    this.activated.clear();
  }

  private async abortScripts(matches: (key: string) => boolean) {
    const executions = [...this.activeScripts.entries()]
      .filter(([key]) => matches(key))
      .flatMap(([, scripts]) => [...scripts.values()]);
    if (!executions.length) return;
    for (const execution of executions) execution.controller.abort(new Error("SKILL_SCRIPT_ABORTED"));
    let settled: PromiseSettledResult<unknown>[];
    try {
      settled = await lifecycleDeadline(
        Promise.allSettled(executions.map((execution) => execution.promise)),
        SCRIPT_LIFECYCLE_CLOSE_TIMEOUT_MS
      );
    } catch {
      throw new Error("SKILL_SCRIPT_CLEANUP_FAILED");
    }
    if (settled.some((result, index) => result.status === "rejected" && executions[index]?.cleanupFailed)) {
      throw new Error("SKILL_SCRIPT_CLEANUP_FAILED");
    }
  }

  private requireActivation(agentId: string, conversationId: string, skillId: string) {
    const session = this.requireSession(agentId, conversationId);
    const activated = session.skills.get(skillId);
    if (!activated) throw new Error("SKILL_NOT_ACTIVATED");
    return activated;
  }

  private requireSession(agentId: string, conversationId: string) {
    const session = this.activated.get(sessionKey(agentId, conversationId));
    if (!session) throw new Error("SKILL_NOT_ACTIVATED");
    return session;
  }

  private admitSession(key: string) {
    return this.withCapacityLock(() => {
      const existing = this.activated.get(key);
      if (existing) return { session: existing, created: false };
      if (this.activated.size >= MAX_ACTIVE_CONVERSATIONS) {
        throw new Error("SKILL_CONVERSATION_LIMIT");
      }
      const session: ActivatedSession = {
        skills: new Map<string, ActivatedSkill>(), injectedBytes: 0, reservedBytes: 0
      };
      this.activated.set(key, session);
      return { session, created: true };
    });
  }

  private releaseEmptyAdmission(key: string, session: ActivatedSession) {
    return this.withCapacityLock(() => {
      if (this.activated.get(key) === session && !session.skills.size &&
          session.injectedBytes === 0 && session.reservedBytes === 0) {
        this.activated.delete(key);
      }
    });
  }

  private touchSessionLocked(key: string, session: ActivatedSession) {
    return this.withCapacityLock(() => {
      if (this.activated.get(key) !== session) throw new Error("SKILL_SESSION_INVALID");
      this.activated.delete(key);
      this.activated.set(key, session);
    });
  }

  private withActivationLock<T>(key: string, operation: () => Promise<T> | T) {
    const previous = this.activationTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.activationTails.set(key, tail);
    return previous.then(operation).finally(() => {
      release();
      if (this.activationTails.get(key) === tail) this.activationTails.delete(key);
    });
  }

  private withCapacityLock<T>(operation: () => Promise<T> | T) {
    const previous = this.capacityTail;
    let release!: () => void;
    this.capacityTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }
}

function chargeSession(session: ActivatedSession, value: unknown) {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("SKILL_CONTEXT_BUDGET_EXCEEDED");
  }
  const bytes = Buffer.byteLength(encoded ?? "", "utf8");
  if (!Number.isSafeInteger(bytes) || bytes < 0 ||
      session.injectedBytes + session.reservedBytes + bytes > SKILL_ACTIVATION_MAX_CONVERSATION_BYTES) {
    throw new Error("SKILL_CONTEXT_BUDGET_EXCEEDED");
  }
  session.injectedBytes += bytes;
}

function reserveSession(session: ActivatedSession, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 ||
      session.injectedBytes + session.reservedBytes + maximumBytes > SKILL_ACTIVATION_MAX_CONVERSATION_BYTES) {
    throw new Error("SKILL_CONTEXT_BUDGET_EXCEEDED");
  }
  session.reservedBytes += maximumBytes;
  let active = true;
  return {
    commit(value: unknown) {
      if (!active) throw new Error("SKILL_CONTEXT_RESERVATION_INVALID");
      active = false;
      session.reservedBytes -= maximumBytes;
      const bytes = serializedBytes(value);
      if (bytes > maximumBytes) throw new Error("SKILL_CONTEXT_RESERVATION_INVALID");
      session.injectedBytes += bytes;
    },
    release() {
      if (!active) return;
      active = false;
      session.reservedBytes -= maximumBytes;
    }
  };
}

function boundedSuccessfulScriptResult(value: unknown, maximumBytes: number) {
  const bytes = serializedBytes(value, Number.MAX_SAFE_INTEGER);
  if (bytes <= maximumBytes) return value;
  return {
    ok: true,
    truncated: true,
    outputByteLength: bytes,
    message: "Skill script completed; output was truncated."
  };
}

function serializedBytes(value: unknown, fallback = 0) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return fallback;
  }
}

function sessionKey(agentId: string, conversationId: string) {
  if (!agentId || !conversationId || agentId.includes("\0") || conversationId.includes("\0")) {
    throw new Error("SKILL_SESSION_INVALID");
  }
  return `${agentId}\0${conversationId}`;
}

function activationFlightKey(session: string, record: AgentSkillRecord) {
  const scriptBearing = record.riskEvidence.classification === "script-bearing" &&
    record.riskEvidence.hasScripts === true;
  return `${session}\0${record.id}\0${record.digestSha256}\0${scriptBearing ? "script" : "instruction"}`;
}

function decodeResourceText(bytes: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return undefined;
    const jsonBytes = Buffer.byteLength(JSON.stringify(text), "utf8");
    const base64Bytes = Math.ceil(bytes.byteLength / 3) * 4;
    return jsonBytes <= base64Bytes ? text : undefined;
  } catch {
    return undefined;
  }
}

function relayAbort(source: AbortSignal | undefined, target: AbortController) {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

function lifecycleDeadline<T>(operation: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SKILL_SCRIPT_CLEANUP_FAILED")), timeoutMs);
    timer.unref?.();
    operation.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
