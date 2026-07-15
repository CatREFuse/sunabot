// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  DurableContractError,
  decodeOutboxDelivery,
  decodeOutboxPayload,
  decodeOutboxRemoteReceipt,
  decodeOutboxSettleProgress,
  decodeSessionEventPayload,
  decodeToolJobCompletion,
  decodeToolJobProcess,
  decodeToolJobRequest,
  decodeTurnOutcome,
  encodeOutboxDelivery,
  encodeOutboxPayload,
  encodeOutboxRemoteReceipt,
  encodeOutboxSettleProgress,
  encodeSessionEventPayload,
  encodeToolJobCompletion,
  encodeToolJobProcess,
  encodeToolJobRequest,
  encodeTurnOutcome
} from "../../packages/contracts/session/durableQueue.js";
import { SessionStore } from "../../services/sessions/sessionStore.js";

const stores: SessionStore[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("durable session codecs", () => {
  it("round-trips every versioned queue family", () => {
    const context = {
      id: "contract-1",
      sessionId: "group:codec",
      occurredAt: 1_700_000_000_000,
      correlationId: "correlation-1",
      causationId: "cause-1",
      idempotencyKey: "dedupe-1"
    };
    const identity = {
      pid: 11,
      processGroupId: 12,
      attempt: 1,
      runToken: "run-1",
      commandMarker: "codex exec",
      startedAt: 1_700_000_000_000
    };

    const event = encodeSessionEventPayload({ text: "hello" }, "incoming", context);
    const turn = encodeTurnOutcome("replied", { text: "done" }, undefined, context);
    const request = encodeToolJobRequest({
      providerCallId: "call-1",
      toolName: "generate_image",
      taskKind: "image",
      originTurnId: "turn-1",
      originalRequest: { message: "draw" },
      arguments: { prompt: "cat" }
    }, context);
    const completion = encodeToolJobCompletion({
      status: "succeeded",
      result: { image: "artifact.png" }
    }, context);
    const process = encodeToolJobProcess(identity, context);
    const outbox = encodeOutboxPayload({ text: "ready" }, "onebot.group", context);
    const delivery = encodeOutboxDelivery({ outcome: "sent", result: { messageId: 7 } }, context);
    const receipt = encodeOutboxRemoteReceipt({ accepted: true, messageId: "7" }, context);
    const settlement = encodeOutboxSettleProgress(["conversation_projection", "request_log"], context);

    for (const encoded of [event, turn, request, completion, process, outbox, delivery, receipt, settlement]) {
      expect(JSON.parse(encoded)).toMatchObject({ schemaVersion: 1, correlationId: "correlation-1" });
    }
    expect(decodeSessionEventPayload(event)).toEqual({ text: "hello" });
    expect(decodeTurnOutcome(turn, null)).toEqual({ result: { text: "done" }, error: undefined });
    expect(decodeToolJobRequest(request, "null")).toEqual({
      originalRequest: { message: "draw" },
      arguments: { prompt: "cat" }
    });
    expect(decodeToolJobCompletion(completion, null)).toEqual({
      result: { image: "artifact.png" },
      error: undefined
    });
    expect(decodeToolJobProcess(process)).toEqual(identity);
    expect(decodeOutboxPayload(outbox)).toEqual({ text: "ready" });
    expect(decodeOutboxDelivery(delivery, null)).toEqual({ result: { messageId: 7 }, error: undefined });
    expect(decodeOutboxRemoteReceipt(receipt)).toEqual({ accepted: true, messageId: "7" });
    expect(decodeOutboxSettleProgress(settlement)).toEqual(["conversation_projection", "request_log"]);
    expect(() => encodeOutboxSettleProgress(["request_log", "request_log"], context)).toThrow(
      "duplicate steps"
    );
  });

  it("reads legacy raw JSON and existing runtime envelopes as v0 data", () => {
    const runtimeEnvelope = {
      schemaVersion: 1,
      id: "runtime-1",
      type: "runtime.incoming_reply",
      occurredAt: "2026-01-01T00:00:00.000Z",
      correlationId: "message-1",
      payload: { type: "incoming_reply" }
    };

    expect(decodeSessionEventPayload(JSON.stringify(runtimeEnvelope))).toEqual(runtimeEnvelope);
    expect(decodeTurnOutcome('{"legacyResult":true}', '{"legacyError":"none"}')).toEqual({
      result: { legacyResult: true },
      error: { legacyError: "none" }
    });
    expect(decodeToolJobRequest('{"legacyRequest":true}', '{"legacyArguments":true}')).toEqual({
      originalRequest: { legacyRequest: true },
      arguments: { legacyArguments: true }
    });
    expect(decodeToolJobCompletion('{"legacyResult":true}', '{"legacyError":true}')).toEqual({
      result: { legacyResult: true },
      error: { legacyError: true }
    });
    expect(decodeOutboxPayload('{"legacyOutbox":true}')).toEqual({ legacyOutbox: true });
    expect(decodeOutboxDelivery('{"legacyDelivery":true}', null)).toEqual({
      result: { legacyDelivery: true },
      error: undefined
    });
  });

  it("classifies future versions as needs-migration and malformed v1 as dead", () => {
    expectContractFailure(() => decodeSessionEventPayload(JSON.stringify(futureEnvelope(
      "session.turn_requested",
      { kind: "incoming", value: {} }
    ))), "needs-migration");
    expectContractFailure(() => decodeToolJobRequest(JSON.stringify(futureEnvelope(
      "session.tool_job_requested",
      {}
    )), "null"), "needs-migration");
    expectContractFailure(() => decodeOutboxPayload(JSON.stringify(futureEnvelope(
      "session.outbox_message",
      { kind: "onebot.group", value: {} }
    ))), "needs-migration");
    expectContractFailure(() => decodeOutboxPayload(JSON.stringify({
      ...futureEnvelope("session.outbox_message", {}),
      schemaVersion: 1
    })), "dead");
  });

  it("reopens a legacy database fixture without rewriting its raw JSON rows", async () => {
    const { databasePath, store } = await createHarness("legacy");
    const event = store.enqueueEvent({
      sessionId: "group:legacy",
      kind: "incoming",
      payload: { text: "before" }
    });
    const claimed = store.claimNextTurn({ workerId: "turn-worker" })!;
    const deferred = store.deferTurn({
      turnId: claimed.turn.id,
      workerId: "turn-worker",
      job: {
        providerCallId: "legacy-call",
        toolName: "generate_image",
        originalRequest: { before: "request" },
        arguments: { before: "arguments" }
      },
      acknowledgement: { kind: "onebot.group", payload: { before: "outbox" } }
    });
    store.close();

    const fixture = new DatabaseSync(databasePath);
    fixture.prepare("UPDATE session_events SET payload_json = ? WHERE id = ?")
      .run('{"legacyEvent":true}', event.event.id);
    fixture.prepare("UPDATE turns SET result_json = ?, error_json = ? WHERE id = ?")
      .run('{"legacyTurnResult":true}', '{"legacyTurnError":true}', claimed.turn.id);
    fixture.prepare(`
      UPDATE tool_jobs
      SET original_request_json = ?, arguments_json = ?, result_json = ?, error_json = ?, process_identity_json = ?
      WHERE id = ?
    `).run(
      '{"legacyRequest":true}',
      '{"legacyArguments":true}',
      '{"legacyJobResult":true}',
      '{"legacyJobError":true}',
      JSON.stringify({
        pid: 21,
        processGroupId: 22,
        attempt: 1,
        runToken: "legacy-run",
        commandMarker: "legacy-command",
        startedAt: 1
      }),
      deferred.job.id
    );
    fixture.prepare("UPDATE outbox SET payload_json = ?, result_json = ?, error_json = ? WHERE id = ?")
      .run(
        '{"legacyOutbox":true}',
        '{"legacyDelivery":true}',
        '{"legacyDeliveryError":true}',
        deferred.acknowledgement.id
      );
    fixture.close();

    const reopened = new SessionStore({ databasePath });
    stores.push(reopened);
    expect(reopened.getEvent(event.event.id)?.payload).toEqual({ legacyEvent: true });
    expect(reopened.getTurn(claimed.turn.id)).toMatchObject({
      result: { legacyTurnResult: true },
      error: { legacyTurnError: true }
    });
    expect(reopened.getToolJob(deferred.job.id)).toMatchObject({
      originalRequest: { legacyRequest: true },
      arguments: { legacyArguments: true },
      result: { legacyJobResult: true },
      error: { legacyJobError: true },
      processIdentity: { runToken: "legacy-run" }
    });
    expect(reopened.getOutbox(deferred.acknowledgement.id)).toMatchObject({
      payload: { legacyOutbox: true },
      result: { legacyDelivery: true },
      error: { legacyDeliveryError: true }
    });
  });

  it("routes process, completion, and delivery writes through their v1 codecs", async () => {
    const { databasePath, store } = await createHarness("terminal-writes");
    store.enqueueEvent({
      sessionId: "group:terminal",
      kind: "incoming",
      payload: { text: "draw" }
    });
    const turn = store.claimNextTurn({ workerId: "turn-worker" })!;
    const deferred = store.deferTurn({
      turnId: turn.turn.id,
      workerId: "turn-worker",
      job: {
        providerCallId: "terminal-call",
        toolName: "generate_image",
        originalRequest: { request: true },
        arguments: { prompt: "cat" }
      },
      acknowledgement: { kind: "onebot.group", payload: { text: "working" } }
    });
    const outbox = store.claimNextOutbox({ workerId: "outbox-worker" })!;
    expect(outbox.id).toBe(deferred.acknowledgement.id);
    store.finishOutbox({
      outboxId: outbox.id,
      workerId: "outbox-worker",
      outcome: "sent",
      result: { messageId: 42 }
    });
    const job = store.claimNextToolJob({ workerId: "tool-worker" })!;
    store.recordToolJobProcess(job.id, "tool-worker", job.attempts, job.attemptToken!, {
      pid: 31,
      processGroupId: 32,
      attempt: job.attempts,
      runToken: job.attemptToken!,
      commandMarker: "codex exec",
      startedAt: 1_700_000_000_000
    });

    const processInspection = new DatabaseSync(databasePath, { readOnly: true });
    const processRow = processInspection.prepare("SELECT process_identity_json FROM tool_jobs WHERE id = ?")
      .get(job.id) as { process_identity_json: string };
    expect(JSON.parse(processRow.process_identity_json).type).toBe("session.tool_job_process");
    processInspection.close();

    store.completeToolJob({
      jobId: job.id,
      workerId: "tool-worker",
      attempt: job.attempts,
      attemptToken: job.attemptToken,
      status: "succeeded",
      result: { image: "artifact.png" }
    });

    const terminalInspection = new DatabaseSync(databasePath, { readOnly: true });
    const terminalRow = terminalInspection.prepare(`
      SELECT
        (SELECT result_json FROM tool_jobs WHERE id = ?) AS job_result,
        (SELECT result_json FROM outbox WHERE id = ?) AS outbox_result
    `).get(job.id, outbox.id) as Record<string, string>;
    expect(JSON.parse(terminalRow.job_result).type).toBe("session.tool_job_completed");
    expect(JSON.parse(terminalRow.outbox_result).type).toBe("session.outbox_delivery");
    terminalInspection.close();
  });

  it("persists v1 envelopes and refuses to claim future event, job, or outbox rows", async () => {
    const { databasePath, store } = await createHarness("future");
    const first = store.enqueueEvent({
      sessionId: "group:future",
      kind: "incoming",
      payload: { text: "defer" }
    });
    const claimed = store.claimNextTurn({ workerId: "turn-worker" })!;
    const deferred = store.deferTurn({
      turnId: claimed.turn.id,
      workerId: "turn-worker",
      job: {
        providerCallId: "future-call",
        toolName: "generate_image",
        originalRequest: { request: true },
        arguments: { prompt: "cat" }
      },
      acknowledgement: { kind: "onebot.group", payload: { text: "working" } }
    });
    const second = store.enqueueEvent({
      sessionId: "group:future",
      kind: "incoming",
      payload: { text: "future" }
    });
    store.close();

    const fixture = new DatabaseSync(databasePath);
    const persisted = fixture.prepare(`
      SELECT
        (SELECT payload_json FROM session_events WHERE id = ?) AS event_payload,
        (SELECT result_json FROM turns WHERE id = ?) AS turn_result,
        (SELECT original_request_json FROM tool_jobs WHERE id = ?) AS job_request,
        (SELECT payload_json FROM outbox WHERE id = ?) AS outbox_payload
    `).get(first.event.id, claimed.turn.id, deferred.job.id, deferred.acknowledgement.id) as Record<string, string>;
    expect(JSON.parse(persisted.event_payload).type).toBe("session.turn_requested");
    expect(JSON.parse(persisted.turn_result).type).toBe("session.turn_command");
    expect(JSON.parse(persisted.job_request).type).toBe("session.tool_job_requested");
    expect(JSON.parse(persisted.outbox_payload).type).toBe("session.outbox_message");

    fixture.prepare("UPDATE session_events SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(futureEnvelope("session.turn_requested", {
        kind: "incoming",
        value: { text: "future" }
      })), second.event.id);
    fixture.prepare("UPDATE tool_jobs SET original_request_json = ? WHERE id = ?")
      .run(JSON.stringify(futureEnvelope("session.tool_job_requested", {})), deferred.job.id);
    fixture.prepare("UPDATE outbox SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(futureEnvelope("session.outbox_message", {
        kind: "onebot.group",
        value: { text: "future" }
      })), deferred.acknowledgement.id);
    fixture.close();

    const reopened = new SessionStore({ databasePath });
    stores.push(reopened);
    expectContractFailure(() => reopened.claimNextTurn({
      workerId: "future-turn",
      sessionId: "group:future"
    }), "needs-migration");
    expectContractFailure(() => reopened.claimNextOutbox({ workerId: "future-outbox" }), "needs-migration");

    reopened.close();
    stores.splice(stores.indexOf(reopened), 1);
    const releaseFixture = new DatabaseSync(databasePath);
    releaseFixture.prepare(`
      UPDATE outbox
      SET status = 'sent', delivery_state = 'sent', sent_at = 1, finished_at = 1
      WHERE id = ?
    `).run(deferred.acknowledgement.id);
    releaseFixture.close();

    const released = new SessionStore({ databasePath });
    stores.push(released);
    expectContractFailure(() => released.claimNextToolJob({ workerId: "future-tool" }), "needs-migration");

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    expect(inspection.prepare("SELECT status, attempts FROM session_events WHERE id = ?")
      .get(second.event.id)).toMatchObject({ status: "pending", attempts: 0 });
    expect(inspection.prepare("SELECT status, attempts FROM tool_jobs WHERE id = ?")
      .get(deferred.job.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect(inspection.prepare("SELECT status, attempts FROM outbox WHERE id = ?")
      .get(deferred.acknowledgement.id)).toMatchObject({ status: "sent", attempts: 0 });
    inspection.close();
  });
});

async function createHarness(label: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `sunabot-durable-${label}-`));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "session-queue.sqlite");
  const store = new SessionStore({ databasePath });
  stores.push(store);
  return { databasePath, store };
}

function futureEnvelope(type: string, payload: unknown) {
  return {
    schemaVersion: 2,
    id: "future-1",
    type,
    occurredAt: "2026-01-01T00:00:00.000Z",
    conversationId: "group:future",
    correlationId: "future-correlation",
    payload
  };
}

function expectContractFailure(operation: () => unknown, disposition: "dead" | "needs-migration") {
  try {
    operation();
    throw new Error("Expected durable contract failure.");
  } catch (error) {
    expect(error).toBeInstanceOf(DurableContractError);
    if (!(error instanceof DurableContractError)) throw error;
    expect(error.disposition).toBe(disposition);
  }
}
